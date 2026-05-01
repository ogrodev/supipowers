// tests/context-mode/cache-preview.test.ts
import { describe, expect, test } from "bun:test";
import {
  buildCachePreview,
  HARD_CACHE_OPEN_CHARS,
  sliceCachedText,
} from "../../src/context-mode/cache-preview.js";

describe("buildCachePreview", () => {
  test("empty text stays empty", () => {
    expect(buildCachePreview("")).toBe("");
  });

  test("small text passes through unchanged", () => {
    expect(buildCachePreview("small cached output", 100)).toBe("small cached output");
  });

  test("large text is bounded with deterministic head and tail", () => {
    const text = `${"A".repeat(80)}${"B".repeat(80)}`;
    const preview = buildCachePreview(text, 72);

    expect(Array.from(preview).length).toBeLessThanOrEqual(72);
    expect(preview).toStartWith("A".repeat(20));
    expect(preview).toContain("omitted");
    expect(preview).toEndWith("B".repeat(20));
    expect(preview).not.toContain("A".repeat(80));
  });

  test("CRLF text is preserved when previewed", () => {
    const text = "first\r\nsecond\r\nthird";

    expect(buildCachePreview(text, 100)).toBe(text);
  });
});

describe("sliceCachedText", () => {
  test("offset and limit select a bounded slice", () => {
    expect(sliceCachedText("abcdef", 2, 3)).toEqual({
      text: "cde",
      offset: 2,
      returnedChars: 3,
      totalChars: 6,
      nextOffset: 5,
    });
  });

  test("offset past end returns an empty truthful slice", () => {
    expect(sliceCachedText("abc", 99, 10)).toEqual({
      text: "",
      offset: 3,
      returnedChars: 0,
      totalChars: 3,
      nextOffset: null,
    });
  });

  test("limit is capped at the hard maximum", () => {
    const text = "x".repeat(HARD_CACHE_OPEN_CHARS + 10);
    const slice = sliceCachedText(text, 0, HARD_CACHE_OPEN_CHARS + 1000);

    expect(slice.returnedChars).toBe(HARD_CACHE_OPEN_CHARS);
    expect(slice.nextOffset).toBe(HARD_CACHE_OPEN_CHARS);
    expect(slice.text.length).toBe(HARD_CACHE_OPEN_CHARS);
  });

  test("Unicode offsets count characters without splitting surrogate pairs", () => {
    const slice = sliceCachedText("a🙂bé", 1, 2);

    expect(slice).toEqual({
      text: "🙂b",
      offset: 1,
      returnedChars: 2,
      totalChars: 4,
      nextOffset: 3,
    });
  });

  test("CRLF content is sliced without newline normalization", () => {
    expect(sliceCachedText("a\r\nb\r\nc", 1, 4)).toEqual({
      text: "\r\nb\r",
      offset: 1,
      returnedChars: 4,
      totalChars: 7,
      nextOffset: 5,
    });
  });
});
