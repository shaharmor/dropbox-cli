import { describe, test, expect } from "bun:test";
import { InvalidArgumentError } from "commander";
import { positiveInteger } from "../../src/lib/options";

describe("positiveInteger", () => {
  test("accepts positive integers within the maximum", () => {
    const parse = positiveInteger(1000);
    expect(parse("1")).toBe(1);
    expect(parse("1000")).toBe(1000);
  });

  test("accepts any positive integer without a maximum", () => {
    expect(positiveInteger()("5000")).toBe(5000);
  });

  test.each(["0", "-3", "2.5", "abc", "", "1001", "10abc", " 5"])("rejects %p", (value) => {
    expect(() => positiveInteger(1000)(value)).toThrow(InvalidArgumentError);
  });
});
