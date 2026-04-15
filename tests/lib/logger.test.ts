import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { setVerbose, log, logError } from "../../src/lib/logger";

describe("logger", () => {
  const originalConsoleError = console.error;
  const mockError = mock();

  beforeEach(() => {
    console.error = mockError;
    mockError.mockClear();
    setVerbose(false);
  });

  afterEach(() => {
    console.error = originalConsoleError;
  });

  describe("log", () => {
    test("does not print when verbose is off", () => {
      log("test message");
      expect(mockError).not.toHaveBeenCalled();
    });

    test("prints to stderr with [verbose] prefix when verbose is on", () => {
      setVerbose(true);
      log("test message");
      expect(mockError).toHaveBeenCalledWith("[verbose]", "test message");
    });

    test("prints multiple args when verbose", () => {
      setVerbose(true);
      log("a", "b", 123);
      expect(mockError).toHaveBeenCalledWith("[verbose]", "a", "b", 123);
    });
  });

  describe("logError", () => {
    test("always prints to stderr regardless of verbose setting", () => {
      logError("error msg");
      expect(mockError).toHaveBeenCalledWith("error msg");
    });

    test("prints multiple args", () => {
      logError("error", 42);
      expect(mockError).toHaveBeenCalledWith("error", 42);
    });
  });
});
