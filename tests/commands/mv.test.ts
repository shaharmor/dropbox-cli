import { describe, test, expect, mock, beforeEach } from "bun:test";

const mockRpc = mock();
const mockPollBatchJob = mock();

mock.module("../../src/lib/api", () => ({
  rpc: mockRpc,
  rpcRaw: mock(),
  contentUpload: mock(),
  contentDownload: mock(),
  pollBatchJob: mockPollBatchJob,
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
import { registerMvCommand } from "../../src/commands/mv";

describe("mv command", () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockPollBatchJob.mockReset();
    captured = {};
  });

  test("moves single file with allow_ownership_transfer: false", async () => {
    const metadata = {
      ".tag": "file",
      name: "file.txt",
      path_display: "/Archive/file.txt",
    };
    mockRpc.mockResolvedValueOnce({ metadata });

    const program = new Command();
    registerMvCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "mv",
      "/Documents/file.txt",
      "/Archive/file.txt",
    ]);

    expect(mockRpc).toHaveBeenCalledWith("files/move_v2", {
      from_path: "/Documents/file.txt",
      to_path: "/Archive/file.txt",
      autorename: false,
      allow_ownership_transfer: false,
    });
    expect(captured.success).toEqual(metadata);
  });

  test("renames a file (move to same directory)", async () => {
    mockRpc.mockResolvedValueOnce({
      metadata: { name: "new-name.txt", path_display: "/new-name.txt" },
    });

    const program = new Command();
    registerMvCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "mv",
      "/old-name.txt",
      "/new-name.txt",
    ]);

    expect(mockRpc).toHaveBeenCalledWith(
      "files/move_v2",
      expect.objectContaining({
        from_path: "/old-name.txt",
        to_path: "/new-name.txt",
      })
    );
  });

  test("batch moves multiple files with sync completion", async () => {
    const entries = [
      { ".tag": "success", success: { name: "a.txt" } },
      { ".tag": "success", success: { name: "b.txt" } },
    ];
    mockRpc.mockResolvedValueOnce({ ".tag": "complete", entries });

    const program = new Command();
    registerMvCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "mv",
      "/a.txt",
      "/b.txt",
      "/Archive",
    ]);

    expect(mockRpc).toHaveBeenCalledWith("files/move_batch_v2", {
      entries: [
        { from_path: "/a.txt", to_path: "/Archive/a.txt" },
        { from_path: "/b.txt", to_path: "/Archive/b.txt" },
      ],
      autorename: false,
      allow_ownership_transfer: false,
    });
    expect(captured.success).toEqual(entries);
  });

  test("batch moves with async job polling", async () => {
    mockRpc.mockResolvedValueOnce({
      ".tag": "async_job_id",
      async_job_id: "job-456",
    });
    mockPollBatchJob.mockResolvedValueOnce({
      ".tag": "complete",
      entries: [{ ".tag": "success" }],
    });

    const program = new Command();
    registerMvCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "mv",
      "/a.txt",
      "/b.txt",
      "/Archive",
    ]);

    expect(mockPollBatchJob).toHaveBeenCalledWith(
      "files/move_batch/check_v2",
      "job-456"
    );
  });

  test("passes autorename option", async () => {
    mockRpc.mockResolvedValueOnce({
      metadata: { name: "file.txt", path_display: "/dest/file.txt" },
    });

    const program = new Command();
    registerMvCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "mv",
      "--autorename",
      "/a.txt",
      "/b.txt",
    ]);

    expect(mockRpc).toHaveBeenCalledWith(
      "files/move_v2",
      expect.objectContaining({ autorename: true })
    );
  });
});
