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
import { registerCpCommand } from "../../src/commands/cp";

describe("cp command", () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockPollBatchJob.mockReset();
    captured = {};
  });

  test("copies single file", async () => {
    const metadata = {
      ".tag": "file",
      name: "report.pdf",
      path_display: "/Backup/report.pdf",
    };
    mockRpc.mockResolvedValueOnce({ metadata });

    const program = new Command();
    registerCpCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "cp",
      "/Documents/report.pdf",
      "/Backup/report.pdf",
    ]);

    expect(mockRpc).toHaveBeenCalledWith("files/copy_v2", {
      from_path: "/Documents/report.pdf",
      to_path: "/Backup/report.pdf",
      autorename: false,
    });
    expect(captured.success).toEqual(metadata);
  });

  test("copies with autorename", async () => {
    mockRpc.mockResolvedValueOnce({
      metadata: { name: "file (1).txt", path_display: "/file (1).txt" },
    });

    const program = new Command();
    registerCpCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "cp",
      "--autorename",
      "/a.txt",
      "/b.txt",
    ]);

    expect(mockRpc).toHaveBeenCalledWith(
      "files/copy_v2",
      expect.objectContaining({ autorename: true })
    );
  });

  test("batch copies multiple files with sync completion", async () => {
    const entries = [
      { ".tag": "success", success: { name: "a.txt" } },
      { ".tag": "success", success: { name: "b.txt" } },
    ];
    mockRpc.mockResolvedValueOnce({ ".tag": "complete", entries });

    const program = new Command();
    registerCpCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "cp",
      "/a.txt",
      "/b.txt",
      "/Backup",
    ]);

    expect(mockRpc).toHaveBeenCalledWith("files/copy_batch_v2", {
      entries: [
        { from_path: "/a.txt", to_path: "/Backup/a.txt" },
        { from_path: "/b.txt", to_path: "/Backup/b.txt" },
      ],
      autorename: false,
    });
    expect(captured.success).toEqual(entries);
  });

  test("batch copies with async job polling", async () => {
    mockRpc.mockResolvedValueOnce({
      ".tag": "async_job_id",
      async_job_id: "job-123",
    });

    const completedEntries = [
      { ".tag": "success", success: { name: "a.txt" } },
    ];
    mockPollBatchJob.mockResolvedValueOnce({
      ".tag": "complete",
      entries: completedEntries,
    });

    const program = new Command();
    registerCpCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "cp",
      "/a.txt",
      "/b.txt",
      "/Backup",
    ]);

    expect(mockPollBatchJob).toHaveBeenCalledWith(
      "files/copy_batch/check_v2",
      "job-123"
    );
    expect(captured.success).toEqual(completedEntries);
  });

  test("uses basename for batch destination paths", async () => {
    mockRpc.mockResolvedValueOnce({ ".tag": "complete", entries: [] });

    const program = new Command();
    registerCpCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "cp",
      "/deep/path/file1.txt",
      "/other/file2.txt",
      "/Dest",
    ]);

    expect(mockRpc).toHaveBeenCalledWith(
      "files/copy_batch_v2",
      expect.objectContaining({
        entries: [
          { from_path: "/deep/path/file1.txt", to_path: "/Dest/file1.txt" },
          { from_path: "/other/file2.txt", to_path: "/Dest/file2.txt" },
        ],
      })
    );
  });
});
