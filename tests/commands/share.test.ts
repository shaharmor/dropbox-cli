import { describe, test, expect, mock, beforeEach } from "bun:test";

const mockRpc = mock();
const mockRpcRaw = mock();

mock.module("../../src/lib/api", () => ({
  rpc: mockRpc,
  rpcRaw: mockRpcRaw,
  contentUpload: mock(),
  contentDownload: mock(),
  pollBatchJob: mock(),
}));

let captured: { success?: unknown; error?: { code: string; message: string } } =
  {};

mock.module("../../src/lib/output", () => ({
  printSuccess: (data: unknown) => {
    captured.success = data;
  },
  printError: (code: string, message: string) => {
    captured.error = { code, message };
    throw new Error(`EXIT:${code}`);
  },
  isHuman: () => false,
}));



import { Command } from "commander";
import { registerShareCommand } from "../../src/commands/share";

describe("share command", () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockRpcRaw.mockReset();
    captured = {};
  });

  test("creates a new shared link", async () => {
    const link = {
      url: "https://www.dropbox.com/s/abc123/report.pdf?dl=0",
      name: "report.pdf",
      path_lower: "/documents/report.pdf",
    };
    mockRpcRaw.mockResolvedValueOnce({ ok: true, status: 200, data: link });

    const program = new Command();
    registerShareCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "share",
      "/Documents/report.pdf",
    ]);

    expect(mockRpcRaw).toHaveBeenCalledWith(
      "sharing/create_shared_link_with_settings",
      {
        path: "/Documents/report.pdf",
        settings: {
          requested_visibility: { ".tag": "public" },
          audience: { ".tag": "public" },
          access: { ".tag": "viewer" },
        },
      }
    );
    expect(captured.success).toEqual(link);
  });

  test("returns existing link when already exists", async () => {
    mockRpcRaw.mockResolvedValueOnce({
      ok: false,
      status: 409,
      data: {
        error: { ".tag": "shared_link_already_exists" },
        error_summary: "shared_link_already_exists/.",
      },
    });

    const existingLink = {
      url: "https://www.dropbox.com/s/existing/file.txt?dl=0",
      name: "file.txt",
    };
    mockRpc.mockResolvedValueOnce({ links: [existingLink] });

    const program = new Command();
    registerShareCommand(program);
    await program.parseAsync(["node", "test", "share", "/file.txt"]);

    expect(mockRpc).toHaveBeenCalledWith("sharing/list_shared_links", {
      path: "/file.txt",
      direct_only: true,
    });
    expect(captured.success).toEqual(existingLink);
  });

  test("errors when sharing fails with unknown error", async () => {
    mockRpcRaw.mockResolvedValueOnce({
      ok: false,
      status: 400,
      data: {
        error: { ".tag": "no_permission" },
        error_summary: "no_permission/.",
      },
    });

    const program = new Command();
    registerShareCommand(program);
    await expect(
      program.parseAsync(["node", "test", "share", "/secret.txt"])
    ).rejects.toThrow("EXIT:share_error");
    expect(captured.error?.code).toBe("share_error");
    expect(captured.error?.message).toBe("no_permission/.");
  });

  test("errors with generic message when error_summary is missing", async () => {
    mockRpcRaw.mockResolvedValueOnce({
      ok: false,
      status: 500,
      data: {},
    });

    const program = new Command();
    registerShareCommand(program);
    await expect(
      program.parseAsync(["node", "test", "share", "/path"])
    ).rejects.toThrow("EXIT:share_error");
    expect(captured.error?.message).toBe("Failed to create shared link");
  });
});
