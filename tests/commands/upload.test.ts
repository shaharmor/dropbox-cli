import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

const mockContentUpload = mock();

mock.module("../../src/lib/api", () => ({
  rpc: mock(),
  rpcRaw: mock(),
  contentUpload: mockContentUpload,
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
  formatBytes: (n: number) => `${n} B`,
}));



import { Command } from "commander";
import { registerUploadCommand } from "../../src/commands/upload";
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
      expect.any(Buffer)
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
      expect.any(Buffer)
    );
  });
});
