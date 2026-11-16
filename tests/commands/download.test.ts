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
  isHuman: () => false,
  formatBytes: (n: number) => `${n} B`,
}));
// Simulates volumes without hard links (exFAT, FAT32, some network shares).
let linkFailure: string | undefined;
const realFsPromises = { ...(await import("fs/promises")) };
const mockLink = mock((existing: string, path: string) => linkFailure
  ? Promise.reject(Object.assign(new Error("link failed"), { code: linkFailure }))
  : realFsPromises.link(existing, path));
mock.module("fs/promises", () => ({ ...realFsPromises, link: mockLink }));

import { Command } from "commander";
import { registerDownloadCommand } from "../../src/commands/download";
import { CommandError } from "../../src/types";
import { existsSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync } from "fs";
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

function failingStream(first: string): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (sent) return controller.error(new Error("connection reset"));
      sent = true;
      controller.enqueue(new TextEncoder().encode(first));
    },
  });
}

async function download(...args: string[]): Promise<unknown> {
  const program = new Command();
  registerDownloadCommand(program);
  return program.parseAsync(["node", "test", "download", ...args]).catch((e: unknown) => e);
}

function stagedFiles(dir = "."): string[] {
  return readdirSync(dir).filter(name => name.endsWith(".part"));
}

describe("download command", () => {
  let origCwd: string;

  beforeEach(() => {
    mockContentDownload.mockReset();
    captured = {};
    linkFailure = undefined;
    mockLink.mockClear();
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

  test("writes every streamed chunk and leaves no staging file", async () => {
    mockContentDownload.mockResolvedValueOnce({
      metadata: { name: "a.txt" },
      body: new ReadableStream({
        start(controller) {
          for (const part of ["one,", "two,", "three"]) controller.enqueue(new TextEncoder().encode(part));
          controller.close();
        },
      }),
    });

    expect(await download("/a.txt")).toBeInstanceOf(Command);

    expect(readFileSync("a.txt", "utf-8")).toBe("one,two,three");
    expect((captured.success as any).size).toBe(13);
    expect(stagedFiles()).toEqual([]);
  });

  test("refuses an existing file without --force before calling the API", async () => {
    writeFileSync("a.txt", "keep");

    const error = await download("/a.txt");

    expect(error).toBeInstanceOf(CommandError);
    expect(error).toMatchObject({ code: "output_exists", exitCode: 1 });
    expect((error as Error).message).toContain("--force");
    expect(mockContentDownload).not.toHaveBeenCalled();
    expect(readFileSync("a.txt", "utf-8")).toBe("keep");
    expect(captured.success).toBeUndefined();
  });

  test("refuses an existing file in the target directory without --force", async () => {
    mkdirSync("output");
    writeFileSync("output/b.txt", "keep");
    mockContentDownload.mockResolvedValueOnce({ metadata: { name: "a.txt" }, body: createReadableStream("aaa") });

    const error = await download("/a.txt", "/b.txt", "output");

    expect(error).toMatchObject({ code: "output_exists" });
    expect(mockContentDownload).toHaveBeenCalledTimes(1);
    expect(readFileSync("output/b.txt", "utf-8")).toBe("keep");
    expect(stagedFiles("output")).toEqual([]);
  });

  test("--force replaces an existing file through the human path", async () => {
    writeFileSync("a.txt", "old");
    mockContentDownload.mockResolvedValueOnce({ metadata: { name: "a.txt" }, body: createReadableStream("new bytes") });

    expect(await download("/a.txt", "--force")).toBeInstanceOf(Command);

    expect(mockContentDownload).toHaveBeenCalledWith("files/download", { path: "/a.txt" });
    expect(readFileSync("a.txt", "utf-8")).toBe("new bytes");
    expect(captured.success).toMatchObject({ remote_path: "/a.txt", size: 9 });
    expect(stagedFiles()).toEqual([]);
  });

  test("refuses when the metadata name already exists locally", async () => {
    writeFileSync("actual-name.txt", "keep");
    mockContentDownload.mockResolvedValueOnce({ metadata: { name: "actual-name.txt" }, body: createReadableStream("data") });

    const error = await download("/some/path/file.txt");

    expect(error).toMatchObject({ code: "output_exists" });
    expect(readFileSync("actual-name.txt", "utf-8")).toBe("keep");
    expect(stagedFiles()).toEqual([]);
  });

  test("a stream that fails mid-body leaves neither the file nor a staging file", async () => {
    mockContentDownload.mockResolvedValueOnce({ metadata: { name: "a.txt" }, body: failingStream("partial") });

    const error = await download("/a.txt");

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("connection reset");
    expect(existsSync("a.txt")).toBe(false);
    expect(stagedFiles()).toEqual([]);
    expect(captured.success).toBeUndefined();
  });

  test("a failed --force download keeps the existing file", async () => {
    writeFileSync("a.txt", "keep");
    mockContentDownload.mockResolvedValueOnce({ metadata: { name: "a.txt" }, body: failingStream("partial") });

    expect(await download("/a.txt", "--force")).toBeInstanceOf(Error);

    expect(readFileSync("a.txt", "utf-8")).toBe("keep");
    expect(stagedFiles()).toEqual([]);
  });

  describe("on a volume without hard links", () => {
    beforeEach(() => {
      linkFailure = "ENOTSUP";
    });

    test("still publishes a new file", async () => {
      mockContentDownload.mockResolvedValueOnce({ metadata: { name: "a.txt" }, body: createReadableStream("aaa") });

      expect(await download("/a.txt")).toBeInstanceOf(Command);

      expect(mockLink).toHaveBeenCalledTimes(1);
      expect(readFileSync("a.txt", "utf-8")).toBe("aaa");
      expect(stagedFiles()).toEqual([]);
    });

    test("does not overwrite an existing file", async () => {
      writeFileSync("actual-name.txt", "keep");
      mockContentDownload.mockResolvedValueOnce({ metadata: { name: "actual-name.txt" }, body: createReadableStream("data") });

      const error = await download("/some/path/file.txt");

      expect(error).toMatchObject({ code: "output_exists" });
      expect(mockLink).toHaveBeenCalledTimes(1);
      expect(readFileSync("actual-name.txt", "utf-8")).toBe("keep");
      expect(stagedFiles()).toEqual([]);
    });
  });
});
