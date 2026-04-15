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
  formatBytes: (n: number) => `${n} B`,
  formatDate: (s: string) => s,
}));



import { Command } from "commander";
import { registerLsCommand } from "../../src/commands/ls";

describe("ls command", () => {
  beforeEach(() => {
    mockRpc.mockReset();
    captured = {};
  });

  test("lists root directory with empty string path", async () => {
    mockRpc.mockResolvedValueOnce({
      entries: [
        {
          ".tag": "folder",
          name: "Documents",
          path_display: "/Documents",
          id: "id:1",
        },
        {
          ".tag": "file",
          name: "readme.txt",
          path_display: "/readme.txt",
          id: "id:2",
          size: 1024,
        },
      ],
      cursor: "cursor1",
      has_more: false,
    });

    const program = new Command();
    registerLsCommand(program);
    await program.parseAsync(["node", "test", "ls"]);

    expect(mockRpc).toHaveBeenCalledWith(
      "files/list_folder",
      expect.objectContaining({
        path: "",
        recursive: false,
      })
    );
    expect(captured.success).toHaveLength(2);
  });

  test("normalizes / to empty string for root", async () => {
    mockRpc.mockResolvedValueOnce({
      entries: [],
      cursor: "c",
      has_more: false,
    });

    const program = new Command();
    registerLsCommand(program);
    await program.parseAsync(["node", "test", "ls", "/"]);

    expect(mockRpc).toHaveBeenCalledWith(
      "files/list_folder",
      expect.objectContaining({ path: "" })
    );
  });

  test("lists specific folder", async () => {
    mockRpc.mockResolvedValueOnce({
      entries: [
        {
          ".tag": "file",
          name: "photo.jpg",
          path_display: "/Photos/photo.jpg",
          id: "id:3",
          size: 5000,
        },
      ],
      cursor: "c",
      has_more: false,
    });

    const program = new Command();
    registerLsCommand(program);
    await program.parseAsync(["node", "test", "ls", "/Photos"]);

    expect(mockRpc).toHaveBeenCalledWith(
      "files/list_folder",
      expect.objectContaining({ path: "/Photos" })
    );
    expect(captured.success).toHaveLength(1);
  });

  test("respects --limit flag and trims results", async () => {
    mockRpc.mockResolvedValueOnce({
      entries: [
        { ".tag": "file", name: "a.txt", path_display: "/a.txt", size: 100 },
        { ".tag": "file", name: "b.txt", path_display: "/b.txt", size: 200 },
        { ".tag": "file", name: "c.txt", path_display: "/c.txt", size: 300 },
      ],
      cursor: "c",
      has_more: false,
    });

    const program = new Command();
    registerLsCommand(program);
    await program.parseAsync(["node", "test", "ls", "--limit", "2"]);

    expect(captured.success).toHaveLength(2);
  });

  test("caps limit to Dropbox max of 2000", async () => {
    mockRpc.mockResolvedValueOnce({
      entries: [],
      cursor: "c",
      has_more: false,
    });

    const program = new Command();
    registerLsCommand(program);
    await program.parseAsync(["node", "test", "ls", "--limit", "5000"]);

    expect(mockRpc).toHaveBeenCalledWith(
      "files/list_folder",
      expect.objectContaining({ limit: 2000 })
    );
  });

  test("auto-paginates when has_more is true", async () => {
    mockRpc
      .mockResolvedValueOnce({
        entries: [
          { ".tag": "file", name: "a.txt", path_display: "/a.txt", size: 100 },
        ],
        cursor: "cursor1",
        has_more: true,
      })
      .mockResolvedValueOnce({
        entries: [
          { ".tag": "file", name: "b.txt", path_display: "/b.txt", size: 200 },
        ],
        cursor: "cursor2",
        has_more: false,
      });

    const program = new Command();
    registerLsCommand(program);
    await program.parseAsync(["node", "test", "ls"]);

    expect(mockRpc).toHaveBeenCalledTimes(2);
    expect(mockRpc).toHaveBeenCalledWith("files/list_folder/continue", {
      cursor: "cursor1",
    });
    expect(captured.success).toHaveLength(2);
  });

  test("stops paginating when limit is reached", async () => {
    mockRpc.mockResolvedValueOnce({
      entries: [
        { ".tag": "file", name: "a.txt", path_display: "/a.txt", size: 100 },
        { ".tag": "file", name: "b.txt", path_display: "/b.txt", size: 200 },
      ],
      cursor: "cursor1",
      has_more: true,
    });

    const program = new Command();
    registerLsCommand(program);
    await program.parseAsync(["node", "test", "ls", "--limit", "2"]);

    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(captured.success).toHaveLength(2);
  });

  test("passes recursive flag", async () => {
    mockRpc.mockResolvedValueOnce({
      entries: [],
      cursor: "c",
      has_more: false,
    });

    const program = new Command();
    registerLsCommand(program);
    await program.parseAsync(["node", "test", "ls", "--recursive"]);

    expect(mockRpc).toHaveBeenCalledWith(
      "files/list_folder",
      expect.objectContaining({ recursive: true })
    );
  });

  test("filters by --type folder", async () => {
    mockRpc.mockResolvedValueOnce({
      entries: [
        { ".tag": "folder", name: "Photos", path_display: "/Photos", id: "id:1" },
        { ".tag": "file", name: "readme.txt", path_display: "/readme.txt", id: "id:2", size: 100 },
        { ".tag": "folder", name: "Docs", path_display: "/Docs", id: "id:3" },
      ],
      cursor: "c",
      has_more: false,
    });

    const program = new Command();
    registerLsCommand(program);
    await program.parseAsync(["node", "test", "ls", "--type", "folder"]);

    expect(captured.success).toHaveLength(2);
    expect((captured.success as any[]).every((e) => e[".tag"] === "folder")).toBe(true);
  });

  test("filters by --type file", async () => {
    mockRpc.mockResolvedValueOnce({
      entries: [
        { ".tag": "folder", name: "Photos", path_display: "/Photos", id: "id:1" },
        { ".tag": "file", name: "a.txt", path_display: "/a.txt", id: "id:2", size: 100 },
        { ".tag": "file", name: "b.txt", path_display: "/b.txt", id: "id:3", size: 200 },
      ],
      cursor: "c",
      has_more: false,
    });

    const program = new Command();
    registerLsCommand(program);
    await program.parseAsync(["node", "test", "ls", "--type", "file"]);

    expect(captured.success).toHaveLength(2);
    expect((captured.success as any[]).every((e) => e[".tag"] === "file")).toBe(true);
  });

  test("errors when --limit and --type are combined", async () => {
    const program = new Command();
    program.exitOverride();
    registerLsCommand(program);

    await expect(
      program.parseAsync(["node", "test", "ls", "--limit", "10", "--type", "folder"])
    ).rejects.toThrow("--limit and --type cannot be used together");
  });

  test("returns empty array for empty folder", async () => {
    mockRpc.mockResolvedValueOnce({
      entries: [],
      cursor: "c",
      has_more: false,
    });

    const program = new Command();
    registerLsCommand(program);
    await program.parseAsync(["node", "test", "ls", "/empty"]);

    expect(captured.success).toEqual([]);
  });
});
