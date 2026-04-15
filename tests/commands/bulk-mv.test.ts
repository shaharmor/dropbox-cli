import { describe, test, expect, mock, beforeEach } from "bun:test";

const mockRpc = mock();
const mockRpcRaw = mock();
const mockPollBatchJob = mock();

mock.module("../../src/lib/api", () => ({
  rpc: mockRpc,
  rpcRaw: mockRpcRaw,
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
import { registerBulkMvCommand } from "../../src/commands/bulk-mv";

describe("bulk-mv command", () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockRpcRaw.mockReset();
    mockPollBatchJob.mockReset();
    captured = {};
  });

  test("moves files matching prefix pattern", async () => {
    // mkdir dest folder
    mockRpcRaw.mockResolvedValueOnce({ ok: true, status: 200, data: {} });

    // list_folder: mix of matching and non-matching files
    mockRpc.mockResolvedValueOnce({
      entries: [
        {
          ".tag": "file",
          name: "2024-01-report.pdf",
          path_display: "/Source/2024-01-report.pdf",
        },
        {
          ".tag": "file",
          name: "2024-02-report.pdf",
          path_display: "/Source/2024-02-report.pdf",
        },
        {
          ".tag": "file",
          name: "2023-12-report.pdf",
          path_display: "/Source/2023-12-report.pdf",
        },
        {
          ".tag": "folder",
          name: "subfolder",
          path_display: "/Source/subfolder",
        },
      ],
      cursor: "c",
      has_more: false,
    });

    // move_batch_v2 for the 2 matching files
    mockRpc.mockResolvedValueOnce({
      ".tag": "complete",
      entries: [{ ".tag": "success" }, { ".tag": "success" }],
    });

    const program = new Command();
    registerBulkMvCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "bulk-mv",
      "/Source",
      "/Dest",
      "--match",
      "2024-",
    ]);

    expect(captured.success).toEqual(
      expect.objectContaining({
        matched: 2,
        moved: 2,
        dry_run: false,
        source: "/Source",
        dest: "/Dest",
        pattern: "2024-",
      })
    );
  });

  test("dry run shows matches but does not move", async () => {
    mockRpc.mockResolvedValueOnce({
      entries: [
        {
          ".tag": "file",
          name: "2024-file.txt",
          path_display: "/Source/2024-file.txt",
        },
        {
          ".tag": "file",
          name: "other.txt",
          path_display: "/Source/other.txt",
        },
      ],
      cursor: "c",
      has_more: false,
    });

    const program = new Command();
    registerBulkMvCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "bulk-mv",
      "/Source",
      "/Dest",
      "--match",
      "2024-",
      "--dry-run",
    ]);

    // Should not create dest folder or move any files
    expect(mockRpcRaw).not.toHaveBeenCalled();
    expect(captured.success).toEqual(
      expect.objectContaining({
        matched: 1,
        moved: 0,
        dry_run: true,
      })
    );
  });

  test("paginates through folder listing", async () => {
    mockRpcRaw.mockResolvedValueOnce({ ok: true, status: 200, data: {} });

    mockRpc
      .mockResolvedValueOnce({
        entries: [
          {
            ".tag": "file",
            name: "match-a.txt",
            path_display: "/S/match-a.txt",
          },
        ],
        cursor: "cursor1",
        has_more: true,
      })
      .mockResolvedValueOnce({
        entries: [
          {
            ".tag": "file",
            name: "match-b.txt",
            path_display: "/S/match-b.txt",
          },
        ],
        cursor: "cursor2",
        has_more: false,
      })
      // move_batch response
      .mockResolvedValueOnce({ ".tag": "complete", entries: [] });

    const program = new Command();
    registerBulkMvCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "bulk-mv",
      "/S",
      "/D",
      "--match",
      "match-",
    ]);

    expect(mockRpc).toHaveBeenCalledWith("files/list_folder/continue", {
      cursor: "cursor1",
    });
    expect(captured.success).toEqual(
      expect.objectContaining({
        matched: 2,
        moved: 2,
      })
    );
  });

  test("handles no matching files", async () => {
    mockRpcRaw.mockResolvedValueOnce({ ok: true, status: 200, data: {} });

    mockRpc.mockResolvedValueOnce({
      entries: [
        {
          ".tag": "file",
          name: "other.txt",
          path_display: "/S/other.txt",
        },
      ],
      cursor: "c",
      has_more: false,
    });

    const program = new Command();
    registerBulkMvCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "bulk-mv",
      "/S",
      "/D",
      "--match",
      "nope-",
    ]);

    expect(captured.success).toEqual(
      expect.objectContaining({
        matched: 0,
        moved: 0,
      })
    );
  });

  test("strips trailing * from match pattern", async () => {
    mockRpcRaw.mockResolvedValueOnce({ ok: true, status: 200, data: {} });

    mockRpc.mockResolvedValueOnce({
      entries: [
        {
          ".tag": "file",
          name: "2024-file.txt",
          path_display: "/S/2024-file.txt",
        },
      ],
      cursor: "c",
      has_more: false,
    });
    mockRpc.mockResolvedValueOnce({ ".tag": "complete", entries: [] });

    const program = new Command();
    registerBulkMvCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "bulk-mv",
      "/S",
      "/D",
      "--match",
      "2024-*",
    ]);

    expect(captured.success).toEqual(
      expect.objectContaining({ matched: 1 })
    );
  });

  test("skips folders, only moves files", async () => {
    mockRpcRaw.mockResolvedValueOnce({ ok: true, status: 200, data: {} });

    mockRpc.mockResolvedValueOnce({
      entries: [
        {
          ".tag": "folder",
          name: "prefix-folder",
          path_display: "/S/prefix-folder",
        },
        {
          ".tag": "file",
          name: "prefix-file.txt",
          path_display: "/S/prefix-file.txt",
        },
      ],
      cursor: "c",
      has_more: false,
    });
    mockRpc.mockResolvedValueOnce({ ".tag": "complete", entries: [] });

    const program = new Command();
    registerBulkMvCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "bulk-mv",
      "/S",
      "/D",
      "--match",
      "prefix-",
    ]);

    // Only the file should match, not the folder
    expect(captured.success).toEqual(
      expect.objectContaining({ matched: 1, moved: 1 })
    );
  });

  test("normalizes root source path to empty string", async () => {
    mockRpcRaw.mockResolvedValueOnce({ ok: true, status: 200, data: {} });

    mockRpc.mockResolvedValueOnce({
      entries: [],
      cursor: "c",
      has_more: false,
    });

    const program = new Command();
    registerBulkMvCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "bulk-mv",
      "/",
      "/D",
      "--match",
      "x",
    ]);

    expect(mockRpc).toHaveBeenCalledWith(
      "files/list_folder",
      expect.objectContaining({ path: "" })
    );
  });

  test("handles dest folder already existing", async () => {
    // mkdir returns error (folder exists) - should continue
    mockRpcRaw.mockResolvedValueOnce({
      ok: false,
      status: 409,
      data: { error: { ".tag": "path/conflict/folder" } },
    });

    mockRpc.mockResolvedValueOnce({
      entries: [
        {
          ".tag": "file",
          name: "match.txt",
          path_display: "/S/match.txt",
        },
      ],
      cursor: "c",
      has_more: false,
    });
    mockRpc.mockResolvedValueOnce({ ".tag": "complete", entries: [] });

    const program = new Command();
    registerBulkMvCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "bulk-mv",
      "/S",
      "/D",
      "--match",
      "match",
    ]);

    // Should still proceed despite mkdir error
    expect(captured.success).toEqual(
      expect.objectContaining({ matched: 1, moved: 1 })
    );
  });
});
