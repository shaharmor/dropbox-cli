import { beforeEach, describe, expect, mock, test } from "bun:test";
import { realpathSync } from "fs";

class UpgradeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const latestRelease = mock();
const replaceBinary = mock();
let compiled = true;
let asset: string | null = "dropbox-cli-linux-x64";

mock.module("../../src/lib/update", () => ({
  CURRENT_VERSION: "1.0.0",
  RELEASES_URL: "https://github.com/shaharmor/dropbox-cli/releases",
  UpgradeError,
  assetName: () => asset,
  isCompiledBinary: () => compiled,
  isNewer: (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true }) > 0,
  latestRelease,
  replaceBinary,
}));

let captured: { success?: unknown; error?: string } = {};

mock.module("../../src/lib/output", () => ({
  printSuccess: (data: unknown) => {
    captured.success = data;
  },
  printError: (code: string) => {
    captured.error = code;
    throw new Error(`EXIT:${code}`);
  },
  isHuman: () => false,
}));

import { Command } from "commander";
import { registerUpgradeCommand } from "../../src/commands/upgrade";

async function run() {
  const program = new Command();
  registerUpgradeCommand(program);
  await program.parseAsync(["node", "test", "upgrade"]).catch((error: Error) => {
    if (!error.message.startsWith("EXIT:")) throw error;
  });
}

describe("upgrade command", () => {
  beforeEach(() => {
    latestRelease.mockReset();
    replaceBinary.mockReset();
    compiled = true;
    asset = "dropbox-cli-linux-x64";
    captured = {};
  });

  test("reports up to date and changes nothing when already on the latest release", async () => {
    latestRelease.mockResolvedValueOnce({ tag: "v1.0.0", version: "1.0.0" });
    await run();
    expect(captured.success).toEqual({ previous_version: "1.0.0", version: "1.0.0", updated: false });
    expect(replaceBinary).not.toHaveBeenCalled();
  });

  test("replaces the running binary when a newer release exists", async () => {
    latestRelease.mockResolvedValueOnce({ tag: "v1.2.0", version: "1.2.0" });
    replaceBinary.mockResolvedValueOnce(undefined);
    await run();
    expect(replaceBinary).toHaveBeenCalledWith(realpathSync(process.execPath), "v1.2.0", "dropbox-cli-linux-x64");
    expect(captured.success).toEqual({ previous_version: "1.0.0", version: "1.2.0", updated: true });
  });

  test("reports a structured error when the binary cannot be replaced", async () => {
    latestRelease.mockResolvedValueOnce({ tag: "v1.2.0", version: "1.2.0" });
    replaceBinary.mockRejectedValueOnce(new UpgradeError("permission_denied", "Cannot write."));
    await run();
    expect(captured.error).toBe("permission_denied");
    expect(captured.success).toBeUndefined();
  });

  test("refuses to run from source without checking for releases", async () => {
    compiled = false;
    await run();
    expect(captured.error).toBe("upgrade_unsupported");
    expect(latestRelease).not.toHaveBeenCalled();
  });

  test("refuses on platforms without a published binary", async () => {
    asset = null;
    await run();
    expect(captured.error).toBe("upgrade_unsupported");
    expect(latestRelease).not.toHaveBeenCalled();
  });
});
