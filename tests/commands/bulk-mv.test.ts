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
  isHuman: () => false,
}));



import { Command } from "commander";
import { registerBulkMvCommand } from "../../src/commands/bulk-mv";
import { CommandError } from "../../src/types";

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
        failed: 0,
        failures: [],
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
        failures: [],
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
      .mockResolvedValueOnce({ ".tag": "complete", entries: [{ ".tag": "success" }, { ".tag": "success" }] });

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
    mockRpc.mockResolvedValueOnce({ ".tag": "complete", entries: [{ ".tag": "success" }] });

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
      data: { error: { ".tag": "path", path: { ".tag": "conflict", conflict: { ".tag": "folder" } } } },
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
    mockRpc.mockResolvedValueOnce({ ".tag": "complete", entries: [{ ".tag": "success" }] });

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

  test("reports count and reason when some files fail to move", async () => {
    mockRpcRaw.mockResolvedValueOnce({ ok: true, status: 200, data: {} });

    mockRpc.mockResolvedValueOnce({
      entries: [
        { ".tag": "file", name: "a.txt", path_display: "/S/a.txt" },
        { ".tag": "file", name: "b.txt", path_display: "/S/b.txt" },
        { ".tag": "file", name: "c.txt", path_display: "/S/c.txt" },
      ],
      cursor: "c",
      has_more: false,
    });
    mockRpc.mockResolvedValueOnce({
      ".tag": "complete",
      entries: [
        { ".tag": "success" },
        {
          ".tag": "failure",
          failure: {
            ".tag": "relocation_error",
            relocation_error: {
              ".tag": "to",
              to: { ".tag": "conflict", conflict: { ".tag": "file" } },
            },
          },
        },
        { ".tag": "success" },
      ],
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
      "",
    ]);

    expect(captured.success).toEqual(
      expect.objectContaining({
        matched: 3,
        moved: 2,
        failed: 1,
        failures: [{ path: "/S/b.txt", reason: "relocation_error/to/conflict/file" }],
      })
    );
  });

  test("reports single-tag failure reasons and unknown when none is given", async () => {
    mockRpcRaw.mockResolvedValueOnce({ ok: true, status: 200, data: {} });

    mockRpc.mockResolvedValueOnce({
      entries: [
        { ".tag": "file", name: "a.txt", path_display: "/S/a.txt" },
        { ".tag": "file", name: "b.txt", path_display: "/S/b.txt" },
      ],
      cursor: "c",
      has_more: false,
    });
    mockRpc.mockResolvedValueOnce({
      ".tag": "complete",
      entries: [
        { ".tag": "failure", failure: { ".tag": "too_many_write_operations" } },
        { ".tag": "failure" },
      ],
    });

    const program = new Command();
    registerBulkMvCommand(program);
    await program.parseAsync(["node", "test", "bulk-mv", "/S", "/D", "--match", ""]);

    expect(captured.success).toEqual(
      expect.objectContaining({
        moved: 0,
        failed: 2,
        failures: [
          { path: "/S/a.txt", reason: "too_many_write_operations" },
          { path: "/S/b.txt", reason: "unknown" },
        ],
      })
    );
  });

  test("collects failures from every batch", async () => {
    mockRpcRaw.mockResolvedValueOnce({ ok: true, status: 200, data: {} });

    mockRpc.mockResolvedValueOnce({
      entries: [
        { ".tag": "file", name: "a.txt", path_display: "/S/a.txt" },
        { ".tag": "file", name: "b.txt", path_display: "/S/b.txt" },
      ],
      cursor: "c",
      has_more: false,
    });
    mockRpc
      .mockResolvedValueOnce({
        ".tag": "complete",
        entries: [{ ".tag": "failure", failure: { ".tag": "internal_error" } }],
      })
      .mockResolvedValueOnce({
        ".tag": "complete",
        entries: [{ ".tag": "failure", failure: { ".tag": "too_many_write_operations" } }],
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
      "",
      "--batch-size",
      "1",
    ]);

    expect(captured.success).toEqual(
      expect.objectContaining({
        failed: 2,
        failures: [
          { path: "/S/a.txt", reason: "internal_error" },
          { path: "/S/b.txt", reason: "too_many_write_operations" },
        ],
      })
    );
  });

  test.each([
    [401, "auth_error", "Dropbox authentication was refused. Reconnect the account.", 2],
    [503, "destination_create_failed", "Destination creation failed or is uncertain. No files were moved; verify the destination before retrying.", 1],
  ])("a %d destination create rejects with %s before listing", async (status, code, message, exitCode) => {
    mockRpcRaw.mockResolvedValueOnce({ ok: false, status, data: {} });

    const program = new Command();
    registerBulkMvCommand(program);
    const error = await program.parseAsync(["node", "test", "bulk-mv", "/S", "/D", "--match", ""]).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CommandError);
    expect(error).toMatchObject({ code, message, exitCode });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  test("a parallel batch failure stops the run before any further move batch", async () => {
    mockRpcRaw.mockResolvedValueOnce({ ok: true, status: 200, data: {} });
    mockRpc.mockImplementation(async (endpoint: string) => {
      if (endpoint === "files/list_folder") {
        return { entries: [{ ".tag": "file", name: "a.txt", path_display: "/S/a.txt" }], cursor: "c1", has_more: true };
      }
      if (endpoint === "files/list_folder/continue") {
        // Batch 1 fails while this page is still being fetched.
        await Bun.sleep(20);
        return { entries: [{ ".tag": "file", name: "b.txt", path_display: "/S/b.txt" }], cursor: "c2", has_more: false };
      }
      return { ".tag": "async_job_id", async_job_id: "fake-job" };
    });
    mockPollBatchJob.mockRejectedValueOnce(new CommandError("batch_error", "[batch 1] Batch job failed: failed"));

    const program = new Command();
    registerBulkMvCommand(program);
    const error = await program.parseAsync([
      "node", "test", "bulk-mv", "/S", "/D", "--match", "", "--parallel", "2", "--batch-size", "1",
    ]).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CommandError);
    expect(error).toMatchObject({ code: "batch_error", message: "[batch 1] Batch job failed: failed", exitCode: 1 });
    expect(mockRpc.mock.calls.filter(([endpoint]) => endpoint === "files/move_batch_v2")).toHaveLength(1);
    expect(captured.success).toBeUndefined();
  });
});
