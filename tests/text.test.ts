import { describe, expect, test } from "bun:test";
import { normalizeLineEndings } from "../src/text.js";

describe("normalizeLineEndings", () => {
  test("converts CRLF to LF", () => {
    expect(normalizeLineEndings("a\r\nb\r\n")).toBe("a\nb\n");
  });

  test("leaves LF-only text unchanged", () => {
    expect(normalizeLineEndings("a\nb\n")).toBe("a\nb\n");
  });
});
