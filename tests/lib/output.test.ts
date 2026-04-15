// tests/lib/output.test.ts
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { formatSuccess, formatError, setHumanMode, isHuman } from "../../src/lib/output";

describe("output", () => {
  test("formatSuccess wraps data in ok envelope", () => {
    const result = formatSuccess({ name: "test.txt" });
    expect(result).toEqual({ ok: true, data: { name: "test.txt" } });
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
});
