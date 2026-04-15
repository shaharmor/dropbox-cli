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
}));



import { Command } from "commander";
import { registerMkdirCommand } from "../../src/commands/mkdir";

describe("mkdir command", () => {
  beforeEach(() => {
    mockRpc.mockReset();
    captured = {};
  });

  test("creates a folder with autorename disabled", async () => {
    const metadata = {
      name: "new-project",
      path_display: "/Projects/new-project",
      id: "id:folder1",
    };
    mockRpc.mockResolvedValueOnce({ metadata });

    const program = new Command();
    registerMkdirCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "mkdir",
      "/Projects/new-project",
    ]);

    expect(mockRpc).toHaveBeenCalledWith("files/create_folder_v2", {
      path: "/Projects/new-project",
      autorename: false,
    });
    expect(captured.success).toEqual(metadata);
  });

  test("creates nested folders", async () => {
    const metadata = {
      name: "January",
      path_display: "/Photos/2024/January",
    };
    mockRpc.mockResolvedValueOnce({ metadata });

    const program = new Command();
    registerMkdirCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "mkdir",
      "/Photos/2024/January",
    ]);

    expect(mockRpc).toHaveBeenCalledWith("files/create_folder_v2", {
      path: "/Photos/2024/January",
      autorename: false,
    });
  });
});
