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
}));



import { Command } from "commander";
import { registerSearchCommand } from "../../src/commands/search";

function makeMatch(
  tag: string,
  name: string,
  path: string,
  size?: number
): { metadata: { metadata: Record<string, unknown> } } {
  const entry: Record<string, unknown> = {
    ".tag": tag,
    name,
    path_display: path,
  };
  if (size !== undefined) entry.size = size;
  return { metadata: { metadata: entry } };
}

describe("search command", () => {
  beforeEach(() => {
    mockRpc.mockReset();
    captured = {};
  });

  test("searches with correct API params", async () => {
    mockRpc.mockResolvedValueOnce({ matches: [], has_more: false });

    const program = new Command();
    registerSearchCommand(program);
    await program.parseAsync(["node", "test", "search", "report"]);

    expect(mockRpc).toHaveBeenCalledWith("files/search_v2", {
      query: "report",
      options: {
        max_results: 100,
        file_status: { ".tag": "active" },
        filename_only: false,
      },
    });
  });

  test("returns matched entries", async () => {
    mockRpc.mockResolvedValueOnce({
      matches: [
        makeMatch("file", "report.pdf", "/report.pdf", 1024),
        makeMatch("folder", "reports", "/reports"),
      ],
      has_more: false,
    });

    const program = new Command();
    registerSearchCommand(program);
    await program.parseAsync(["node", "test", "search", "report"]);

    const results = captured.success as any[];
    expect(results).toHaveLength(2);
    expect(results[0].name).toBe("report.pdf");
    expect(results[1].name).toBe("reports");
  });

  test("searches within a specific path", async () => {
    mockRpc.mockResolvedValueOnce({ matches: [], has_more: false });

    const program = new Command();
    registerSearchCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "search",
      "budget",
      "--path",
      "/Documents",
    ]);

    expect(mockRpc).toHaveBeenCalledWith(
      "files/search_v2",
      expect.objectContaining({
        query: "budget",
        options: expect.objectContaining({
          path: "/Documents",
        }),
      })
    );
  });

  test("respects --limit and trims results", async () => {
    mockRpc.mockResolvedValueOnce({
      matches: [
        makeMatch("file", "a.txt", "/a.txt", 10),
        makeMatch("file", "b.txt", "/b.txt", 20),
        makeMatch("file", "c.txt", "/c.txt", 30),
      ],
      has_more: false,
    });

    const program = new Command();
    registerSearchCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "search",
      "test",
      "--limit",
      "2",
    ]);

    expect(captured.success).toHaveLength(2);
  });

  test("caps max_results to 1000 per API call", async () => {
    mockRpc.mockResolvedValueOnce({ matches: [], has_more: false });

    const program = new Command();
    registerSearchCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "search",
      "x",
      "--limit",
      "5000",
    ]);

    expect(mockRpc).toHaveBeenCalledWith(
      "files/search_v2",
      expect.objectContaining({
        options: expect.objectContaining({ max_results: 1000 }),
      })
    );
  });

  test("paginates search results", async () => {
    mockRpc
      .mockResolvedValueOnce({
        matches: [makeMatch("file", "a.txt", "/a.txt", 10)],
        has_more: true,
        cursor: "search-cursor-1",
      })
      .mockResolvedValueOnce({
        matches: [makeMatch("file", "b.txt", "/b.txt", 20)],
        has_more: false,
      });

    const program = new Command();
    registerSearchCommand(program);
    await program.parseAsync(["node", "test", "search", "test"]);

    expect(mockRpc).toHaveBeenCalledTimes(2);
    expect(mockRpc).toHaveBeenCalledWith("files/search/continue_v2", {
      cursor: "search-cursor-1",
    });
    expect(captured.success).toHaveLength(2);
  });

  test("returns empty array when no results", async () => {
    mockRpc.mockResolvedValueOnce({ matches: [], has_more: false });

    const program = new Command();
    registerSearchCommand(program);
    await program.parseAsync(["node", "test", "search", "nonexistent"]);

    expect(captured.success).toEqual([]);
  });
});
