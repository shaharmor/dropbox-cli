import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";

const mockContentUpload = mock();
const mockContentUploadRaw = mock();

mock.module("../../src/lib/api", () => ({
  rpc: mock(),
  rpcRaw: mock(),
  contentUpload: mockContentUpload,
  contentUploadRaw: mockContentUploadRaw,
  contentDownload: mock(),
  pollBatchJob: mock(),
}));

let captured: { success?: unknown } = {};

mock.module("../../src/lib/output", () => ({
  printSuccess: (data: unknown) => {
    captured.success = data;
  },
  isHuman: () => false,
  formatBytes: (n: number) => `${n} B`,
}));



import { Command } from "commander";
import { registerUploadCommand } from "../../src/commands/upload";
import { CommandError } from "../../src/types";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

const TEST_DIR = join(import.meta.dir, ".test-upload");

describe("upload command", () => {
  beforeEach(() => {
    mockContentUpload.mockReset();
    captured = {};
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, "test.txt"), "hello world");
    writeFileSync(join(TEST_DIR, "a.txt"), "file a");
    writeFileSync(join(TEST_DIR, "b.txt"), "file b");
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("uploads a single file", async () => {
    const metadata = {
      ".tag": "file",
      name: "test.txt",
      path_display: "/remote/test.txt",
      size: 11,
    };
    mockContentUpload.mockResolvedValueOnce(metadata);

    const program = new Command();
    registerUploadCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "upload",
      join(TEST_DIR, "test.txt"),
      "/remote/test.txt",
    ]);

    expect(mockContentUpload).toHaveBeenCalledWith(
      "files/upload",
      expect.objectContaining({
        path: "/remote/test.txt",
        mode: { ".tag": "add" },
        autorename: false,
        strict_conflict: true,
      }),
      expect.any(Blob)
    );
    expect(captured.success).toEqual(metadata);
  });

  test("uploads multiple files to a directory", async () => {
    mockContentUpload
      .mockResolvedValueOnce({
        name: "a.txt",
        path_display: "/dest/a.txt",
        size: 6,
      })
      .mockResolvedValueOnce({
        name: "b.txt",
        path_display: "/dest/b.txt",
        size: 6,
      });

    const program = new Command();
    registerUploadCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "upload",
      join(TEST_DIR, "a.txt"),
      join(TEST_DIR, "b.txt"),
      "/dest",
    ]);

    expect(mockContentUpload).toHaveBeenCalledTimes(2);
    expect(mockContentUpload.mock.calls[0][1]).toEqual(
      expect.objectContaining({ path: "/dest/a.txt" })
    );
    expect(mockContentUpload.mock.calls[1][1]).toEqual(
      expect.objectContaining({ path: "/dest/b.txt" })
    );
    // Multiple files return an array
    expect(captured.success).toHaveLength(2);
  });

  test.each([
    ["/Dir/", "/Dir"],
    ["/", ""],
  ])("multiple files to %p upload under it without a doubled slash", async (dest, dir) => {
    mockContentUpload.mockResolvedValue({ name: "x", size: 6 });

    const program = new Command();
    registerUploadCommand(program);
    await program.parseAsync(["node", "test", "upload", join(TEST_DIR, "a.txt"), join(TEST_DIR, "b.txt"), dest]);

    expect(mockContentUpload.mock.calls.map((call) => call[1].path)).toEqual([`${dir}/a.txt`, `${dir}/b.txt`]);
  });

  test("single file returns single result (not array)", async () => {
    mockContentUpload.mockResolvedValueOnce({
      name: "test.txt",
      size: 11,
    });

    const program = new Command();
    registerUploadCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "upload",
      join(TEST_DIR, "test.txt"),
      "/remote.txt",
    ]);

    // Single file returns the object directly, not wrapped in array
    expect(captured.success).toEqual({ name: "test.txt", size: 11 });
  });

  test("passes autorename option", async () => {
    mockContentUpload.mockResolvedValueOnce({ name: "test.txt", size: 11 });

    const program = new Command();
    registerUploadCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "upload",
      "--autorename",
      join(TEST_DIR, "test.txt"),
      "/remote/test.txt",
    ]);

    expect(mockContentUpload).toHaveBeenCalledWith(
      "files/upload",
      expect.objectContaining({
        autorename: true,
        strict_conflict: false,
      }),
      expect.any(Blob)
    );
  });

  test("rejects a single argument as invalid_args", async () => {
    const program = new Command();
    registerUploadCommand(program);
    const error = await program.parseAsync(["node", "test", "upload", "./a.txt"]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CommandError);
    expect(error).toMatchObject({ code: "invalid_args", message: "Usage: dropbox-cli upload <local-file...> <remote-path>", exitCode: 1 });
    expect(mockContentUpload).not.toHaveBeenCalled();
  });
});

describe("upload sessions", () => {
  const CHUNK = 8 * 1024 * 1024;
  const SESSION_DIR = join(import.meta.dir, ".test-upload-session");
  const LOCAL = join(SESSION_DIR, "large.bin");
  const METADATA = { name: "large.bin", path_display: "/remote/large.bin" };

  type Call = { endpoint: string; arg: { cursor?: { offset: number } }; bytes: Uint8Array; options?: { retry?: string } };
  let calls: Call[];
  let appendResults: Array<() => unknown>;
  let finishError: Error | undefined;
  let sleep: ReturnType<typeof spyOn<typeof Bun, "sleep">>;

  const appends = () => calls.filter((call) => call.endpoint === "files/upload_session/append_v2");
  const finishes = () => calls.filter((call) => call.endpoint === "files/upload_session/finish");
  const offsets = (list: Call[]) => list.map((call) => call.arg.cursor?.offset);

  // Built once; each test writes a prefix of it.
  const PATTERN = new Uint8Array(3 * CHUNK + 1);
  for (let i = 0; i < PATTERN.length; i++) PATTERN[i] = i % 251;

  function writeLocal(size: number): Uint8Array {
    const bytes = PATTERN.subarray(0, size);
    writeFileSync(LOCAL, bytes);
    return bytes;
  }

  async function record(endpoint: string, arg: Call["arg"], body: Blob, options?: Call["options"]) {
    calls.push({ endpoint, arg, bytes: new Uint8Array(await body.arrayBuffer()), options });
  }

  function upload() {
    const program = new Command();
    registerUploadCommand(program);
    return program.parseAsync(["node", "test", "upload", LOCAL, "/remote/large.bin"]);
  }

  const connectionError = () => { throw new CommandError("connection_error", "Dropbox request could not be completed."); };
  const incorrectOffset = (correct: number) => () => ({
    ok: false, status: 409,
    data: { error_summary: "incorrect_offset/..", error: { ".tag": "incorrect_offset", correct_offset: correct } },
  });

  beforeEach(() => {
    mockContentUpload.mockReset();
    mockContentUploadRaw.mockReset();
    captured = {};
    calls = [];
    appendResults = [];
    finishError = undefined;
    mkdirSync(SESSION_DIR, { recursive: true });
    sleep = spyOn(Bun, "sleep").mockResolvedValue(undefined);
    mockContentUpload.mockImplementation(async (endpoint: string, arg: Call["arg"], body: Blob, options?: Call["options"]) => {
      await record(endpoint, arg, body, options);
      if (endpoint === "files/upload_session/start") return { session_id: "fake-session" };
      if (endpoint === "files/upload_session/finish" && finishError) throw finishError;
      return METADATA;
    });
    mockContentUploadRaw.mockImplementation(async (endpoint: string, arg: Call["arg"], body: Blob, options?: Call["options"]) => {
      await record(endpoint, arg, body, options);
      const next = appendResults.shift();
      return next ? next() : { ok: true, status: 200, data: null };
    });
  });

  afterEach(() => {
    sleep.mockRestore();
    rmSync(SESSION_DIR, { recursive: true, force: true });
  });

  test("a file several chunks long is sent as start, appends and finish whose bytes equal the file", async () => {
    const bytes = writeLocal(2 * CHUNK + 12345);

    await upload();

    expect(calls.map((call) => call.endpoint)).toEqual([
      "files/upload_session/start",
      "files/upload_session/append_v2",
      "files/upload_session/finish",
    ]);
    expect(offsets(calls.slice(1))).toEqual([CHUNK, 2 * CHUNK]);
    expect(Buffer.concat(calls.map((call) => call.bytes)).equals(Buffer.from(bytes))).toBe(true);
    expect(calls.every((call) => call.bytes.length <= CHUNK)).toBe(true);
    expect(calls[0].options).toEqual({ retry: "read" });
    expect(calls[1].options).toEqual({ retry: "read" });
    expect(calls[2].options?.retry).toBeUndefined();
    expect(finishes()[0].arg).toMatchObject({
      cursor: { session_id: "fake-session", offset: 2 * CHUNK },
      commit: { path: "/remote/large.bin", mode: { ".tag": "add" }, autorename: false, strict_conflict: true },
    });
    expect(captured.success).toEqual(METADATA);
  });

  test("a file one byte over the chunk size is sent as start plus finish", async () => {
    writeLocal(CHUNK + 1);

    await upload();

    expect(calls.map((call) => [call.endpoint, call.bytes.length])).toEqual([
      ["files/upload_session/start", CHUNK],
      ["files/upload_session/finish", 1],
    ]);
  });

  test("a file of exactly one chunk is sent as a single files/upload request", async () => {
    writeLocal(CHUNK);

    await upload();

    expect(calls.map((call) => [call.endpoint, call.bytes.length])).toEqual([["files/upload", CHUNK]]);
  });

  test("a file at a chunk-size multiple ends with a full last slice in finish", async () => {
    writeLocal(3 * CHUNK);

    await upload();

    expect(calls.map((call) => [call.endpoint, call.bytes.length])).toEqual([
      ["files/upload_session/start", CHUNK],
      ["files/upload_session/append_v2", CHUNK],
      ["files/upload_session/finish", CHUNK],
    ]);
    expect(finishes()[0].arg.cursor?.offset).toBe(2 * CHUNK);
  });

  test("an append whose response is lost is re-sent at the same offset", async () => {
    const bytes = writeLocal(2 * CHUNK + 1);
    appendResults = [connectionError];

    await upload();

    expect(offsets(appends())).toEqual([CHUNK, CHUNK]);
    expect(Buffer.from(appends()[1].bytes).equals(Buffer.from(bytes.subarray(CHUNK, 2 * CHUNK)))).toBe(true);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(finishes()).toHaveLength(1);
    expect(captured.success).toEqual(METADATA);
  });

  test("an incorrect_offset at the end of the sent chunk continues without re-sending it", async () => {
    writeLocal(3 * CHUNK + 1);
    appendResults = [connectionError, incorrectOffset(2 * CHUNK)];

    await upload();

    expect(offsets(appends())).toEqual([CHUNK, CHUNK, 2 * CHUNK]);
    expect(offsets(finishes())).toEqual([3 * CHUNK]);
    expect(captured.success).toEqual(METADATA);
  });

  test.each([
    ["behind the current offset", 0],
    ["equal to the current offset", CHUNK],
    ["beyond the file size", 3 * CHUNK + 2],
  ])("an incorrect_offset %s fails without finishing", async (_label, correct) => {
    writeLocal(3 * CHUNK + 1);
    appendResults = [incorrectOffset(correct)];

    const error = await upload().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CommandError);
    expect(error).toMatchObject({ code: "incorrect_offset", exitCode: 1 });
    expect(appends()).toHaveLength(1);
    expect(finishes()).toHaveLength(0);
  });

  test("appends that keep losing their response exhaust retries and fail without finishing", async () => {
    writeLocal(2 * CHUNK + 1);
    appendResults = Array(10).fill(connectionError);

    const error = await upload().catch((e: unknown) => e);

    expect(error).toMatchObject({ code: "connection_error" });
    expect(offsets(appends())).toEqual([CHUNK, CHUNK, CHUNK, CHUNK]);
    expect(finishes()).toHaveLength(0);
  });

  test.each([
    [{ ok: false, status: 401, data: null }, { code: "auth_error", exitCode: 2 }],
    [{ ok: false, status: 409, data: { error_summary: "closed/..", error: { ".tag": "closed" } } }, { code: "closed", message: "closed/..", exitCode: 1 }],
  ])("an append refused with %p fails at once without finishing", async (result, expected) => {
    writeLocal(2 * CHUNK + 1);
    appendResults = [() => result];

    const error = await upload().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CommandError);
    expect(error).toMatchObject(expected);
    expect(appends()).toHaveLength(1);
    expect(finishes()).toHaveLength(0);
  });

  test("a finish whose response is lost is sent once and says the upload may have completed", async () => {
    writeLocal(CHUNK + 1);
    finishError = new CommandError("connection_error", "Dropbox request could not be completed.");

    const error = await upload().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CommandError);
    expect(error).toMatchObject({ code: "unknown_outcome", exitCode: 1 });
    expect((error as Error).message).toContain("may have completed");
    expect((error as Error).message).toContain("/remote/large.bin");
    expect(finishes()).toHaveLength(1);
  });

  test("a finish refused by Dropbox is sent once and reports Dropbox's error", async () => {
    writeLocal(CHUNK + 1);
    finishError = new CommandError("path", "path/conflict/file/..");

    const error = await upload().catch((e: unknown) => e);

    expect(error).toBe(finishError);
    expect(finishes()).toHaveLength(1);
  });

  test("a directory fails before any request is sent", async () => {
    const error = await (async () => {
      const program = new Command();
      registerUploadCommand(program);
      return program.parseAsync(["node", "test", "upload", SESSION_DIR, "/remote/dir"]);
    })().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CommandError);
    expect(error).toMatchObject({ code: "invalid_args" });
    expect(calls).toHaveLength(0);
  });
});
