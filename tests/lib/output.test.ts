import { describe, test, expect, beforeEach, spyOn } from "bun:test";
import {
  formatSuccess,
  formatError,
  setHumanMode,
  isHuman,
  formatBytes,
  formatDate,
  printSuccess,
} from "../../src/lib/output";

describe("output", () => {
  test("formatSuccess wraps data in ok envelope", () => {
    const result = formatSuccess({ name: "test.txt" });
    expect(result).toEqual({ ok: true, data: { name: "test.txt" } });
  });

  test("formatSuccess wraps arrays", () => {
    const result = formatSuccess([1, 2, 3]);
    expect(result).toEqual({ ok: true, data: [1, 2, 3] });
  });

  test("formatSuccess wraps null", () => {
    const result = formatSuccess(null);
    expect(result).toEqual({ ok: true, data: null });
  });

  test("formatError wraps code and message", () => {
    const result = formatError("not_found", "File not found");
    expect(result).toEqual({
      ok: false,
      error: { code: "not_found", message: "File not found" },
    });
  });

  test("human mode toggle", () => {
    expect(isHuman()).toBe(false);
    setHumanMode(true);
    expect(isHuman()).toBe(true);
    setHumanMode(false);
    expect(isHuman()).toBe(false);
  });

  describe("formatBytes", () => {
    test("formats 0 bytes", () => {
      expect(formatBytes(0)).toBe("0 B");
    });

    test("formats bytes under 1 KB", () => {
      expect(formatBytes(500)).toBe("500 B");
    });

    test("formats exactly 1 KB", () => {
      expect(formatBytes(1024)).toBe("1.0 KB");
    });

    test("formats megabytes", () => {
      expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    });

    test("formats gigabytes", () => {
      expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GB");
    });

    test("formats fractional sizes", () => {
      expect(formatBytes(1536)).toBe("1.5 KB");
    });

    test("formats large file size", () => {
      expect(formatBytes(1024 * 1024 * 1024 * 1024)).toBe("1.0 TB");
    });
  });

  describe("formatDate", () => {
    test("formats ISO date string", () => {
      const result = formatDate("2024-01-15T10:30:00Z");
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe("printSuccess", () => {
    test("outputs JSON-formatted success envelope to stdout", () => {
      const logSpy = spyOn(console, "log").mockImplementation(() => {});
      printSuccess({ key: "value" });
      expect(logSpy).toHaveBeenCalledWith(
        JSON.stringify({ ok: true, data: { key: "value" } }, null, 2)
      );
      logSpy.mockRestore();
    });

    test("outputs array data", () => {
      const logSpy = spyOn(console, "log").mockImplementation(() => {});
      printSuccess([1, 2]);
      expect(logSpy).toHaveBeenCalledWith(
        JSON.stringify({ ok: true, data: [1, 2] }, null, 2)
      );
      logSpy.mockRestore();
    });
  });
});
