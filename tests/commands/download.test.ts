import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

const mockContentDownload = mock();

mock.module("../../src/lib/api", () => ({
  rpc: mock(),
  rpcRaw: mock(),
  contentUpload: mock(),
  contentDownload: mockContentDownload,
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
}));



import { Command } from "commander";
import { registerDownloadCommand } from "../../src/commands/download";
import { existsSync, readFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";

const TEST_DIR = join(import.meta.dir, ".test-download");

function createReadableStream(data: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(data));
      controller.close();
    },
  });
}

describe("download command", () => {
  let origCwd: string;

  beforeEach(() => {
    mockContentDownload.mockReset();
    captured = {};
    mkdirSync(TEST_DIR, { recursive: true });
    origCwd = process.cwd();
    // chdir so we can use relative local paths (download command treats
    // absolute paths starting with / as remote Dropbox paths)
    process.chdir(TEST_DIR);
  });

  afterEach(() => {
    process.chdir(origCwd);
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("downloads a single file to current directory", async () => {
    mockContentDownload.mockResolvedValueOnce({
      metadata: { name: "report.pdf" },
      body: createReadableStream("file content here"),
    });

    const program = new Command();
    registerDownloadCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "download",
      "/Documents/report.pdf",
    ]);

    expect(mockContentDownload).toHaveBeenCalledWith("files/download", {
      path: "/Documents/report.pdf",
    });

    expect(existsSync("report.pdf")).toBe(true);
    expect(readFileSync("report.pdf", "utf-8")).toBe("file content here");

    const result = captured.success as any;
    expect(result.remote_path).toBe("/Documents/report.pdf");
    expect(result.size).toBe(17);
  });

  test("downloads a file to a specified local directory", async () => {
    mockContentDownload.mockResolvedValueOnce({
      metadata: { name: "report.pdf" },
      body: createReadableStream("content"),
    });

    const program = new Command();
    registerDownloadCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "download",
      "/Documents/report.pdf",
      "output",
    ]);

    expect(existsSync("output/report.pdf")).toBe(true);
    expect(readFileSync("output/report.pdf", "utf-8")).toBe("content");
  });

  test("downloads multiple files", async () => {
    mockContentDownload
      .mockResolvedValueOnce({
        metadata: { name: "a.txt" },
        body: createReadableStream("aaa"),
      })
      .mockResolvedValueOnce({
        metadata: { name: "b.txt" },
        body: createReadableStream("bbb"),
      });

    const program = new Command();
    registerDownloadCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "download",
      "/a.txt",
      "/b.txt",
      "output",
    ]);

    expect(mockContentDownload).toHaveBeenCalledTimes(2);
    expect(existsSync("output/a.txt")).toBe(true);
    expect(existsSync("output/b.txt")).toBe(true);
    expect(readFileSync("output/a.txt", "utf-8")).toBe("aaa");
    expect(readFileSync("output/b.txt", "utf-8")).toBe("bbb");
    expect(captured.success).toHaveLength(2);
  });

  test("treats all args as remote when last arg starts with /", async () => {
    mockContentDownload
      .mockResolvedValueOnce({
        metadata: { name: "x.txt" },
        body: createReadableStream("x"),
      })
      .mockResolvedValueOnce({
        metadata: { name: "y.txt" },
        body: createReadableStream("y"),
      });

    const program = new Command();
    registerDownloadCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "download",
      "/x.txt",
      "/y.txt",
    ]);

    // Both start with /, so both are remote → download to cwd
    expect(mockContentDownload).toHaveBeenCalledTimes(2);
    expect(existsSync("x.txt")).toBe(true);
    expect(existsSync("y.txt")).toBe(true);
  });

  test("uses filename from metadata", async () => {
    mockContentDownload.mockResolvedValueOnce({
      metadata: { name: "actual-name.txt" },
      body: createReadableStream("data"),
    });

    const program = new Command();
    registerDownloadCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "download",
      "/some/path/file.txt",
    ]);

    expect(existsSync("actual-name.txt")).toBe(true);
  });
});
