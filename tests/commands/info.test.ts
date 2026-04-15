import { describe, test, expect, mock, beforeEach } from "bun:test";

const mockRpc = mock();

mock.module("../../src/lib/api", () => ({
  rpc: mockRpc,
  rpcRaw: mock(),
  contentUpload: mock(),
  contentDownload: mock(),
  pollBatchJob: mock(),
}));

let captured: { success?: unknown } = {};

mock.module("../../src/lib/output", () => ({
  printSuccess: (data: unknown) => {
    captured.success = data;
  },
  printError: (code: string, message: string) => {
    throw new Error(`EXIT:${code}`);
  },
  isHuman: () => false,
  formatBytes: (n: number) => `${n} B`,
  formatDate: (s: string) => s,
}));



import { Command } from "commander";
import { registerInfoCommand } from "../../src/commands/info";

describe("info command", () => {
  beforeEach(() => {
    mockRpc.mockReset();
    captured = {};
  });

  test("gets file metadata with correct API params", async () => {
    const fileEntry = {
      ".tag": "file",
      name: "report.pdf",
      path_display: "/Documents/report.pdf",
      size: 2048,
      server_modified: "2024-01-15T10:00:00Z",
      rev: "abc123",
      content_hash: "hash123",
    };
    mockRpc.mockResolvedValueOnce(fileEntry);

    const program = new Command();
    registerInfoCommand(program);
    await program.parseAsync(["node", "test", "info", "/Documents/report.pdf"]);

    expect(mockRpc).toHaveBeenCalledWith("files/get_metadata", {
      path: "/Documents/report.pdf",
      include_media_info: true,
      include_has_explicit_shared_members: true,
    });
    expect(captured.success).toEqual(fileEntry);
  });

  test("gets folder metadata", async () => {
    const folderEntry = {
      ".tag": "folder",
      name: "Photos",
      path_display: "/Photos",
      id: "id:folder1",
    };
    mockRpc.mockResolvedValueOnce(folderEntry);

    const program = new Command();
    registerInfoCommand(program);
    await program.parseAsync(["node", "test", "info", "/Photos"]);

    expect(captured.success).toEqual(folderEntry);
  });
});
