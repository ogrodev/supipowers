import { describe, expect, test } from "bun:test";
import { ensureTrailingNewline, normalizeLineEndings } from "../src/text.js";

describe("normalizeLineEndings", () => {
  test("converts CRLF to LF", () => {
    expect(normalizeLineEndings("a\r\nb\r\n")).toBe("a\nb\n");
  });

  test("converts lone CR to LF", () => {
    expect(normalizeLineEndings("a\rb\r")).toBe("a\nb\n");
  });

  test("leaves LF-only text unchanged", () => {
    expect(normalizeLineEndings("a\nb\n")).toBe("a\nb\n");
  });
});

describe("ensureTrailingNewline", () => {
  test("adds one LF when text is unterminated", () => {
    expect(ensureTrailingNewline("body")).toBe("body\n");
  });

  test("leaves already terminated text unchanged", () => {
    expect(ensureTrailingNewline("body\n")).toBe("body\n");
  });
});
