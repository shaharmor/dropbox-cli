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



import { Command, CommanderError } from "commander";
import { registerBulkMvCommand } from "../../src/commands/bulk-mv";
import { CommandError, CredentialError } from "../../src/types";

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

  test.each([
    ["--batch-size", "abc"],
    ["--batch-size", "0"],
    ["--batch-size", "1001"],
    ["--batch-size", "2.5"],
    ["--parallel", "0"],
    ["--parallel", "-2"],
    ["--parallel", "x"],
  ])("rejects %s %p before any request", async (flag, value) => {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ outputError: () => {} });
    registerBulkMvCommand(program);

    const error = await program.parseAsync(["node", "test", "bulk-mv", "/S", "/D", "--match", "", flag, value]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CommanderError);
    expect(error).toMatchObject({ code: "commander.invalidArgument", exitCode: 1 });
    expect(mockRpcRaw).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  test("accepts --batch-size 1000", async () => {
    mockRpcRaw.mockResolvedValueOnce({ ok: true, status: 200, data: {} });
    mockRpc
      .mockResolvedValueOnce({
        entries: [{ ".tag": "file", name: "a.txt", path_display: "/S/a.txt" }],
        cursor: "c",
        has_more: false,
      })
      .mockResolvedValueOnce({ ".tag": "complete", entries: [{ ".tag": "success" }] });

    const program = new Command();
    registerBulkMvCommand(program);
    await program.parseAsync(["node", "test", "bulk-mv", "/S", "/D", "--match", "", "--batch-size", "1000"]);

    expect(captured.success).toEqual(expect.objectContaining({ moved: 1 }));
  });

  test.each([
    ["/D/", "/D/a.txt"],
    ["/", "/a.txt"],
  ])("destination %p builds %p", async (dest, toPath) => {
    mockRpcRaw.mockResolvedValueOnce({ ok: true, status: 200, data: {} });
    mockRpc
      .mockResolvedValueOnce({
        entries: [{ ".tag": "file", name: "a.txt", path_display: "/S/a.txt" }],
        cursor: "c",
        has_more: false,
      })
      .mockResolvedValueOnce({ ".tag": "complete", entries: [{ ".tag": "success" }] });

    const program = new Command();
    registerBulkMvCommand(program);
    await program.parseAsync(["node", "test", "bulk-mv", "/S", dest, "--match", ""]);

    expect(mockRpc).toHaveBeenCalledWith("files/move_batch_v2", expect.objectContaining({
      entries: [{ from_path: "/S/a.txt", to_path: toPath }],
    }));
  });

  test("help describes client-side prefix matching and re-running", () => {
    const program = new Command();
    registerBulkMvCommand(program);
    const command = program.commands.find((c) => c.name() === "bulk-mv")!;
    let help = "";
    command.configureOutput({ writeOut: (text) => { help += text; } });
    command.outputHelp();

    expect(help).not.toMatch(/server-side/i);
    expect(help).toContain("case-sensitive");
    expect(help).toMatch(/re-run/i);
  });
});

const file = (name: string) => ({ ".tag": "file", name, path_display: `/S/${name}` });
const moveCalls = () => mockRpc.mock.calls.filter(([endpoint]) => endpoint === "files/move_batch_v2");
const firstPath = (body: { entries: { from_path: string }[] }) => body.entries[0].from_path;

async function runBulkMv(...flags: string[]): Promise<unknown> {
  const program = new Command();
  registerBulkMvCommand(program);
  return program.parseAsync(["node", "test", "bulk-mv", "/S", "/D", "--match", "", ...flags]).catch((e: unknown) => e);
}

describe("bulk-mv partial progress", () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockRpcRaw.mockReset();
    mockPollBatchJob.mockReset();
    captured = {};
    mockRpcRaw.mockResolvedValue({ ok: true, status: 200, data: {} });
  });

  test("a failed batch stops dispatch and reports moved and unconfirmed files", async () => {
    const batchError = new CommandError("batch_error", "[batch 2] Batch job failed: failed");
    mockRpc.mockImplementation(async (endpoint: string, body: { entries: { from_path: string }[] }) => {
      if (endpoint === "files/list_folder") {
        return { entries: [file("a.txt"), file("b.txt"), file("c.txt")], cursor: "c", has_more: false };
      }
      if (firstPath(body) === "/S/a.txt") return { ".tag": "complete", entries: [{ ".tag": "success" }] };
      return { ".tag": "async_job_id", async_job_id: "fake-job" };
    });
    mockPollBatchJob.mockRejectedValueOnce(batchError);

    const error = await runBulkMv("--batch-size", "1");

    expect(error).toBeInstanceOf(CommandError);
    expect(error).toMatchObject({
      code: "bulk_move_incomplete",
      exitCode: 1,
      details: {
        matched: 3,
        moved: 1,
        failed: 0,
        failures: [],
        unconfirmed: ["/S/b.txt"],
        cause: { code: "batch_error", message: "[batch 2] Batch job failed: failed" },
      },
    });
    expect(moveCalls().map(([, body]) => firstPath(body))).toEqual(["/S/a.txt", "/S/b.txt"]);
    expect(captured.success).toBeUndefined();
  });

  test("in-flight batches finish and are reported after another batch fails", async () => {
    mockRpc.mockImplementation(async (endpoint: string, body: { entries: { from_path: string }[] }) => {
      if (endpoint === "files/list_folder") {
        return { entries: ["a", "b", "c", "d", "e"].map((n) => file(`${n}.txt`)), cursor: "c", has_more: false };
      }
      if (firstPath(body) === "/S/a.txt") return { ".tag": "async_job_id", async_job_id: "fake-job" };
      // Batch 2 is still in flight when batch 1 fails.
      await Bun.sleep(20);
      return {
        ".tag": "complete",
        entries: [{ ".tag": "success" }, { ".tag": "failure", failure: { ".tag": "too_many_write_operations" } }],
      };
    });
    mockPollBatchJob.mockRejectedValueOnce(new CommandError("batch_error", "[batch 1] Batch job failed: failed"));

    const error = await runBulkMv("--batch-size", "2", "--parallel", "2");

    expect(error).toMatchObject({
      code: "bulk_move_incomplete",
      exitCode: 1,
      details: {
        matched: 5,
        moved: 1,
        failed: 1,
        failures: [{ path: "/S/d.txt", reason: "too_many_write_operations" }],
        unconfirmed: ["/S/a.txt", "/S/b.txt"],
        cause: { code: "batch_error" },
      },
    });
    expect(moveCalls()).toHaveLength(2);
  });

  test("a listing failure after a batch moved reports the moves", async () => {
    const listError = new CommandError("path_not_found", "Path not found");
    mockRpc.mockImplementation(async (endpoint: string) => {
      if (endpoint === "files/list_folder") return { entries: [file("a.txt")], cursor: "c1", has_more: true };
      if (endpoint === "files/list_folder/continue") throw listError;
      return { ".tag": "complete", entries: [{ ".tag": "success" }] };
    });

    const error = await runBulkMv("--batch-size", "1");

    expect(error).toMatchObject({
      code: "bulk_move_incomplete",
      exitCode: 1,
      details: {
        matched: 1,
        moved: 1,
        failed: 0,
        failures: [],
        unconfirmed: [],
        cause: { code: "path_not_found", message: "Path not found" },
      },
    });
  });

  test("an auth failure on a move batch exits with the auth exit code", async () => {
    mockRpc.mockImplementation(async (endpoint: string) => {
      if (endpoint === "files/list_folder") return { entries: [file("a.txt")], cursor: "c", has_more: false };
      throw new CommandError("auth_error", "Dropbox authentication was refused. Reconnect the account.", 2);
    });

    const error = await runBulkMv();

    expect(error).toMatchObject({
      code: "bulk_move_incomplete",
      exitCode: 2,
      details: { moved: 0, unconfirmed: ["/S/a.txt"], cause: { code: "auth_error" } },
    });
  });

  test("a credential auth failure on a move batch exits with the auth exit code", async () => {
    mockRpc.mockImplementation(async (endpoint: string) => {
      if (endpoint === "files/list_folder") return { entries: [file("a.txt")], cursor: "c", has_more: false };
      throw new CredentialError("auth_error", "Authentication is required.");
    });

    const error = await runBulkMv();

    expect(error).toMatchObject({
      code: "bulk_move_incomplete",
      exitCode: 2,
      details: { cause: { code: "auth_error", message: "Authentication is required." } },
    });
  });

  test("a lost move request reports a connection_error cause", async () => {
    mockRpc.mockImplementation(async (endpoint: string) => {
      if (endpoint === "files/list_folder") return { entries: [file("a.txt")], cursor: "c", has_more: false };
      throw new CommandError("connection_error", "The request could not be completed.");
    });

    const error = await runBulkMv();

    expect(error).toMatchObject({
      code: "bulk_move_incomplete",
      exitCode: 1,
      details: { unconfirmed: ["/S/a.txt"], cause: { code: "connection_error", message: "The request could not be completed." } },
    });
  });

  test("a first listing failure rethrows the original error", async () => {
    const listError = new CommandError("path_not_found", "Path not found");
    mockRpc.mockRejectedValueOnce(listError);

    expect(await runBulkMv()).toBe(listError);
    expect(moveCalls()).toHaveLength(0);
  });

  test("a later listing failure before any batch rethrows the original error", async () => {
    const listError = new CommandError("connection_error", "The request could not be completed.");
    mockRpc
      .mockResolvedValueOnce({ entries: [file("a.txt")], cursor: "c1", has_more: true })
      .mockRejectedValueOnce(listError);

    expect(await runBulkMv()).toBe(listError);
    expect(moveCalls()).toHaveLength(0);
  });
});
