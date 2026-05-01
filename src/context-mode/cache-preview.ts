// src/context-mode/cache-preview.ts

export const DEFAULT_CACHE_PREVIEW_CHARS = 4 * 1024;
export const DEFAULT_CACHE_OPEN_CHARS = 64 * 1024;
export const HARD_CACHE_OPEN_CHARS = 100 * 1024;

const PREVIEW_OMISSION_MARKER = "\n… omitted …\n";

export function buildCachePreview(
  text: string,
  maxChars = DEFAULT_CACHE_PREVIEW_CHARS,
): string {
  const chars = Array.from(text);
  const max = normalizeNonNegativeInteger(maxChars, DEFAULT_CACHE_PREVIEW_CHARS);
  if (max === 0) return "";
  if (chars.length <= max) return text;

  const markerChars = Array.from(PREVIEW_OMISSION_MARKER);
  if (max <= markerChars.length) {
    return markerChars.slice(0, max).join("");
  }

  const contentBudget = max - markerChars.length;
  const headCount = Math.ceil(contentBudget / 2);
  const tailCount = Math.floor(contentBudget / 2);

  return [
    ...chars.slice(0, headCount),
    ...markerChars,
    ...chars.slice(chars.length - tailCount),
  ].join("");
}

export function sliceCachedText(
  text: string,
  offset = 0,
  limit = DEFAULT_CACHE_OPEN_CHARS,
): {
  text: string;
  offset: number;
  returnedChars: number;
  totalChars: number;
  nextOffset: number | null;
} {
  const chars = Array.from(text);
  const totalChars = chars.length;
  const normalizedOffset = Math.min(
    normalizeNonNegativeInteger(offset, 0),
    totalChars,
  );
  const normalizedLimit = Math.min(
    normalizeNonNegativeInteger(limit, DEFAULT_CACHE_OPEN_CHARS),
    HARD_CACHE_OPEN_CHARS,
  );

  const end = Math.min(normalizedOffset + normalizedLimit, totalChars);
  const sliced = chars.slice(normalizedOffset, end).join("");

  return {
    text: sliced,
    offset: normalizedOffset,
    returnedChars: end - normalizedOffset,
    totalChars,
    nextOffset: end < totalChars ? end : null,
  };
}

function normalizeNonNegativeInteger(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}
