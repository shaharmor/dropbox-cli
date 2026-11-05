import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  CURRENT_VERSION, assetName, finishUpdateCheck, isNewer, latestRelease, replaceBinary, startUpdateCheck,
} from "../../src/lib/update";

const realFetch = globalThis.fetch;
let dir: string;
let requests: string[];

function serve(files: Record<string, string | Response>) {
  requests = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    const body = files[url];
    if (body === undefined) return new Response("Not Found", { status: 404 });
    return typeof body === "string" ? new Response(body) : body;
  }) as typeof fetch;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const base = "https://github.com/shaharmor/dropbox-cli/releases/download/v1.2.0";
const asset = "dropbox-cli-linux-x64";

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as Error & { code: string };
  }
  throw new Error("Expected a failure");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dropbox-update-"));
  writeFileSync(join(dir, "dropbox-cli"), "old binary", { mode: 0o755 });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  chmodSync(dir, 0o755);
  rmSync(dir, { recursive: true, force: true });
});

describe("latestRelease", () => {
  const api = "https://api.github.com/repos/shaharmor/dropbox-cli/releases/latest";

  test("reads the tag and version of the latest release", async () => {
    serve({ [api]: Response.json({ tag_name: "v1.2.0" }) });
    expect(await latestRelease()).toEqual({ tag: "v1.2.0", version: "1.2.0" });
  });

  test("fails on an error response", async () => {
    serve({ [api]: new Response("rate limited", { status: 403 }) });
    expect((await failure(latestRelease())).code).toBe("upgrade_failed");
  });

  test("fails when the tag is missing or not a version", async () => {
    serve({ [api]: Response.json({ name: "latest" }) });
    expect((await failure(latestRelease())).code).toBe("upgrade_failed");
    serve({ [api]: Response.json({ tag_name: "../../evil" }) });
    expect((await failure(latestRelease())).code).toBe("upgrade_failed");
  });

  test("fails when GitHub is unreachable", async () => {
    globalThis.fetch = (async () => { throw new TypeError("network down"); }) as unknown as typeof fetch;
    expect((await failure(latestRelease())).code).toBe("upgrade_failed");
  });
});

describe("isNewer", () => {
  test("compares versions numerically", () => {
    expect(isNewer("1.10.0", "1.9.0")).toBe(true);
    expect(isNewer("2.0.0", "1.99.99")).toBe(true);
    expect(isNewer("1.0.0", "1.0.0")).toBe(false);
    expect(isNewer("0.9.0", "1.0.0")).toBe(false);
  });
});

describe("assetName", () => {
  test("names the release asset for supported platforms", () => {
    expect(assetName("darwin", "arm64")).toBe("dropbox-cli-darwin-arm64");
    expect(assetName("darwin", "x64")).toBe("dropbox-cli-darwin-x64");
    expect(assetName("linux", "arm64")).toBe("dropbox-cli-linux-arm64");
    expect(assetName("linux", "x64")).toBe("dropbox-cli-linux-x64");
  });

  test("has no asset for other platforms", () => {
    expect(assetName("win32", "x64")).toBeNull();
    expect(assetName("linux", "ia32")).toBeNull();
  });
});

describe("replaceBinary", () => {
  const target = () => join(dir, "dropbox-cli");

  test("replaces the binary when the checksum matches", async () => {
    serve({ [`${base}/${asset}`]: "new binary", [`${base}/checksums.txt`]: `${sha256("other")}  dropbox-cli-darwin-arm64\n${sha256("new binary")}  ${asset}\n` });
    await replaceBinary(target(), "v1.2.0", asset);
    expect(readFileSync(target(), "utf8")).toBe("new binary");
    expect(statSync(target()).mode & 0o777).toBe(0o755);
    expect(readdirSync(dir)).toEqual(["dropbox-cli"]);
  });

  test("leaves the binary untouched when the checksum does not match", async () => {
    serve({ [`${base}/${asset}`]: "tampered", [`${base}/checksums.txt`]: `${sha256("new binary")}  ${asset}\n` });
    expect((await failure(replaceBinary(target(), "v1.2.0", asset))).code).toBe("checksum_mismatch");
    expect(readFileSync(target(), "utf8")).toBe("old binary");
    expect(readdirSync(dir)).toEqual(["dropbox-cli"]);
  });

  test("refuses when checksums.txt has no entry for the asset", async () => {
    serve({ [`${base}/${asset}`]: "new binary", [`${base}/checksums.txt`]: `${sha256("new binary")}  dropbox-cli-linux-arm64\n` });
    expect((await failure(replaceBinary(target(), "v1.2.0", asset))).code).toBe("checksum_mismatch");
    expect(readFileSync(target(), "utf8")).toBe("old binary");
  });

  test("fails when the asset cannot be downloaded", async () => {
    serve({ [`${base}/checksums.txt`]: `${sha256("new binary")}  ${asset}\n` });
    expect((await failure(replaceBinary(target(), "v1.2.0", asset))).code).toBe("upgrade_failed");
    expect(readFileSync(target(), "utf8")).toBe("old binary");
  });

  test("fails when the download is cut off mid-transfer", async () => {
    const interrupted = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("new bi"));
        controller.error(new Error("connection reset"));
      },
    });
    serve({ [`${base}/${asset}`]: new Response(interrupted), [`${base}/checksums.txt`]: `${sha256("new binary")}  ${asset}\n` });
    expect((await failure(replaceBinary(target(), "v1.2.0", asset))).code).toBe("upgrade_failed");
    expect(readFileSync(target(), "utf8")).toBe("old binary");
  });

  test("refuses a read-only directory before downloading", async () => {
    serve({});
    chmodSync(dir, 0o555);
    expect((await failure(replaceBinary(target(), "v1.2.0", asset))).code).toBe("permission_denied");
    expect(requests).toEqual([]);
    expect(readFileSync(target(), "utf8")).toBe("old binary");
  });
});

describe("update notice", () => {
  const api = "https://api.github.com/repos/shaharmor/dropbox-cli/releases/latest";
  const realError = console.error;
  const realTTY = process.stderr.isTTY;
  const realConfigDir = process.env.DROPBOX_CLI_CONFIG_DIR;
  let stderr: string[];
  const stamp = () => join(dir, "config", "update-check.json");

  beforeEach(() => {
    process.env.DROPBOX_CLI_CONFIG_DIR = join(dir, "config");
    process.stderr.isTTY = true;
    stderr = [];
    console.error = (...args: unknown[]) => { stderr.push(args.join(" ")); };
  });

  afterEach(() => {
    console.error = realError;
    process.stderr.isTTY = realTTY;
    if (realConfigDir === undefined) delete process.env.DROPBOX_CLI_CONFIG_DIR;
    else process.env.DROPBOX_CLI_CONFIG_DIR = realConfigDir;
  });

  test("prints one notice when a newer release exists and records the check", async () => {
    serve({ [api]: Response.json({ tag_name: "v99.0.0" }) });
    startUpdateCheck("ls");
    await finishUpdateCheck();
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain(`${CURRENT_VERSION} → 99.0.0`);
    expect(stderr[0]).toContain("dropbox-cli upgrade");
    expect(JSON.parse(readFileSync(stamp(), "utf8")).checked_at).toBeNumber();
  });

  test("makes no request when stderr is not a terminal", async () => {
    process.stderr.isTTY = false;
    serve({ [api]: Response.json({ tag_name: "v99.0.0" }) });
    startUpdateCheck("ls");
    await finishUpdateCheck();
    expect(requests).toEqual([]);
    expect(stderr).toEqual([]);
  });

  test("makes no request when checked within the last day", async () => {
    serve({ [api]: Response.json({ tag_name: "v99.0.0" }) });
    startUpdateCheck("ls");
    await finishUpdateCheck();
    stderr = [];
    startUpdateCheck("ls");
    await finishUpdateCheck();
    expect(requests).toHaveLength(1);
    expect(stderr).toEqual([]);
  });

  test("checks again once the last check is over a day old", async () => {
    serve({ [api]: Response.json({ tag_name: "v99.0.0" }) });
    startUpdateCheck("ls");
    await finishUpdateCheck();
    writeFileSync(stamp(), JSON.stringify({ checked_at: Date.now() - 25 * 60 * 60 * 1000 }));
    startUpdateCheck("ls");
    await finishUpdateCheck();
    expect(requests).toHaveLength(2);
  });

  test("stays silent offline and still records the attempt", async () => {
    globalThis.fetch = (async () => { throw new TypeError("network down"); }) as unknown as typeof fetch;
    startUpdateCheck("ls");
    await finishUpdateCheck();
    expect(stderr).toEqual([]);
    expect(JSON.parse(readFileSync(stamp(), "utf8")).checked_at).toBeNumber();
  });

  test("abandons a slow check shortly after the command finishes", async () => {
    let aborted = false;
    globalThis.fetch = ((_: unknown, init?: RequestInit) => new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); });
    })) as unknown as typeof fetch;
    startUpdateCheck("ls");
    const started = Date.now();
    await finishUpdateCheck();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(aborted).toBe(true);
    expect(stderr).toEqual([]);
    expect(existsSync(stamp())).toBe(true);
  });

  test("treats an unreadable record as stale", async () => {
    mkdirSync(join(dir, "config"), { recursive: true, mode: 0o700 });
    writeFileSync(stamp(), "not json");
    serve({ [api]: Response.json({ tag_name: "v99.0.0" }) });
    startUpdateCheck("ls");
    await finishUpdateCheck();
    expect(requests).toHaveLength(1);
  });

  test("never checks while running upgrade", async () => {
    serve({ [api]: Response.json({ tag_name: "v99.0.0" }) });
    startUpdateCheck("upgrade");
    await finishUpdateCheck();
    expect(requests).toEqual([]);
  });

  test("prints nothing when already on the latest release", async () => {
    serve({ [api]: Response.json({ tag_name: `v${CURRENT_VERSION}` }) });
    startUpdateCheck("ls");
    await finishUpdateCheck();
    expect(stderr).toEqual([]);
  });
});
