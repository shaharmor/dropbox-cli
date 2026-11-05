import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "../install.sh");
const DOWNLOAD_BASE = "https://github.com/shaharmor/dropbox-cli/releases/latest/download/";
const RELEASES_URL = "https://github.com/shaharmor/dropbox-cli/releases";
const FIXTURE_BINARY = '#!/bin/sh\necho "9.9.9-test"\n';
const OLD_BINARY = '#!/bin/sh\necho "0.0.1-old"\n';

let root: string;
let stubBin: string;
let fixtures: string;
let home: string;
let installDir: string;
let curlLog: string;

function sha256(data: string): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

function writeExecutable(path: string, content: string) {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function stubPlatform(os: string, arch: string, rosetta = false) {
  writeExecutable(
    join(stubBin, "uname"),
    `#!/bin/sh\ncase "$1" in\n  -m) echo "${arch}" ;;\n  *) echo "${os}" ;;\nesac\n`,
  );
  writeExecutable(join(stubBin, "sysctl"), `#!/bin/sh\n${rosetta ? "echo 1" : "exit 1"}\n`);
}

function publishAsset(asset: string, content = FIXTURE_BINARY, checksumLines?: string[]) {
  writeFileSync(join(fixtures, asset), content);
  const lines = checksumLines ?? [
    `${sha256("other")}  dropbox-cli-windows-x64.exe`,
    `${sha256(content)}  ${asset}`,
  ];
  writeFileSync(join(fixtures, "checksums.txt"), lines.join("\n") + "\n");
}

function snapshot(dir: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of readdirSync(dir, { recursive: true }) as string[]) {
    const path = join(dir, name);
    result[name] = statSync(path).isDirectory() ? "<dir>" : readFileSync(path, "utf8");
  }
  return result;
}

async function runInstaller(pathPrefix: string[] = []) {
  const systemPath = (process.env.PATH ?? "")
    .split(":")
    .filter((entry) => entry && entry !== installDir)
    .join(":");
  const proc = Bun.spawn(["sh", SCRIPT], {
    cwd: root,
    env: {
      HOME: home,
      DROPBOX_CLI_INSTALL_DIR: installDir,
      PATH: [stubBin, ...pathPrefix, systemPath].join(":"),
      SHELL: "/bin/zsh",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function requestedUrls(): string[] {
  return existsSync(curlLog) ? readFileSync(curlLog, "utf8").trim().split("\n").filter(Boolean) : [];
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dropbox-cli-install-test-"));
  stubBin = join(root, "stub-bin");
  fixtures = join(root, "fixtures");
  home = join(root, "home");
  installDir = join(root, "install", "bin");
  curlLog = join(root, "curl.log");
  for (const dir of [stubBin, fixtures, home]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(home, ".zshrc"), "# example zshrc\n");

  writeExecutable(
    join(stubBin, "curl"),
    `#!/bin/sh
out=""
url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
echo "$url" >> "${curlLog}"
file="${fixtures}/$(basename "$url")"
[ -f "$file" ] || exit 22
if [ -n "$out" ]; then cp "$file" "$out"; else cat "$file"; fi
`,
  );
  stubPlatform("Linux", "x86_64");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("install.sh", () => {
  test("installs the verified binary and prints PATH instructions without touching dotfiles", async () => {
    publishAsset("dropbox-cli-linux-x64");
    const homeBefore = snapshot(home);

    const result = await runInstaller();

    expect(result.exitCode).toBe(0);
    const installed = join(installDir, "dropbox-cli");
    expect(readFileSync(installed, "utf8")).toBe(FIXTURE_BINARY);
    expect(statSync(installed).mode & 0o111).toBe(0o111);
    expect(result.stdout).toContain("9.9.9-test");
    expect(result.stdout).toContain("~/.zshrc");
    expect(result.stdout.trimEnd().split("\n").at(-1)).toBe(`export PATH="${installDir}:$PATH"`);
    expect(snapshot(home)).toEqual(homeBefore);
    expect(readdirSync(installDir)).toEqual(["dropbox-cli"]);
  });

  test("only downloads from the latest release download URL", async () => {
    publishAsset("dropbox-cli-linux-x64");

    const result = await runInstaller();

    expect(result.exitCode).toBe(0);
    const urls = requestedUrls();
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url.startsWith(DOWNLOAD_BASE)).toBe(true);
    expect(urls).toContain(`${DOWNLOAD_BASE}dropbox-cli-linux-x64`);
    expect(urls).toContain(`${DOWNLOAD_BASE}checksums.txt`);
  });

  test("checksum mismatch fails and leaves the existing install untouched", async () => {
    publishAsset("dropbox-cli-linux-x64", FIXTURE_BINARY, [`${sha256("tampered")}  dropbox-cli-linux-x64`]);
    mkdirSync(installDir, { recursive: true });
    writeExecutable(join(installDir, "dropbox-cli"), OLD_BINARY);

    const result = await runInstaller();

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("dropbox-cli-linux-x64");
    expect(readFileSync(join(installDir, "dropbox-cli"), "utf8")).toBe(OLD_BINARY);
    expect(readdirSync(installDir)).toEqual(["dropbox-cli"]);
  });

  test("missing checksum line for the asset fails and leaves the existing install untouched", async () => {
    publishAsset("dropbox-cli-linux-x64", FIXTURE_BINARY, [
      `${sha256(FIXTURE_BINARY)}  dropbox-cli-linux-arm64`,
      `${sha256(FIXTURE_BINARY)}  dropbox-cli-linux-x64.exe`,
    ]);
    mkdirSync(installDir, { recursive: true });
    writeExecutable(join(installDir, "dropbox-cli"), OLD_BINARY);

    const result = await runInstaller();

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("dropbox-cli-linux-x64");
    expect(readFileSync(join(installDir, "dropbox-cli"), "utf8")).toBe(OLD_BINARY);
  });

  test.each([
    ["MINGW64_NT-10.0", "x86_64"],
    ["Linux", "i686"],
  ])("unsupported platform %s/%s fails with a pointer to the releases page", async (os, arch) => {
    stubPlatform(os, arch);

    const result = await runInstaller();

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(os);
    expect(result.stderr).toContain(arch);
    expect(result.stderr).toContain(RELEASES_URL);
    expect(existsSync(join(installDir, "dropbox-cli"))).toBe(false);
    expect(requestedUrls()).toEqual([]);
  });

  test("re-running replaces an existing install", async () => {
    publishAsset("dropbox-cli-linux-x64");
    mkdirSync(installDir, { recursive: true });
    writeExecutable(join(installDir, "dropbox-cli"), OLD_BINARY);

    const result = await runInstaller();

    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(installDir, "dropbox-cli"), "utf8")).toBe(FIXTURE_BINARY);
    expect(readdirSync(installDir)).toEqual(["dropbox-cli"]);
  });

  test("prints no PATH instructions when the install dir is already on PATH", async () => {
    publishAsset("dropbox-cli-linux-x64");

    const result = await runInstaller([installDir]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("9.9.9-test");
    expect(result.stdout).not.toContain("export PATH=");
    expect(result.stdout).not.toContain(".zshrc");
  });

  test("uses the arm64 build on macOS under Rosetta", async () => {
    stubPlatform("Darwin", "x86_64", true);
    publishAsset("dropbox-cli-darwin-arm64");

    const result = await runInstaller();

    expect(result.exitCode).toBe(0);
    expect(requestedUrls()).toContain(`${DOWNLOAD_BASE}dropbox-cli-darwin-arm64`);
    expect(readFileSync(join(installDir, "dropbox-cli"), "utf8")).toBe(FIXTURE_BINARY);
  });
});
