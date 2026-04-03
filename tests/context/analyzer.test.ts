import { describe, test, expect } from "vitest";
import { estimateTokens, formatSize } from "../../src/context/analyzer.js";

describe("estimateTokens", () => {
  test("returns chars / 4 ceiling for normal text", () => {
    expect(estimateTokens("hello world")).toBe(3); // 11 chars / 4 = 2.75 → 3
  });

  test("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  test("handles single character", () => {
    expect(estimateTokens("a")).toBe(1);
  });
});

describe("formatSize", () => {
  test("formats bytes to KB with 1 decimal for < 10KB", () => {
    expect(formatSize(5120)).toBe("5.0KB");
  });

  test("formats bytes to KB rounded for >= 10KB", () => {
    expect(formatSize(14336)).toBe("14KB");
  });

  test("returns 0KB for 0 bytes", () => {
    expect(formatSize(0)).toBe("0KB");
  });

  test("formats large values", () => {
    expect(formatSize(131072)).toBe("128KB");
  });
});
