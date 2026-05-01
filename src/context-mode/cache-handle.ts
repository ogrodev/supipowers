// src/context-mode/cache-handle.ts

const HANDLE_PREFIX = "cache://";
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const RENDER_SHA256_RE = /^[a-fA-F0-9]{64}$/;
const MAX_DESCRIBED_VALUE_CHARS = 120;
const INVALID_HANDLE_REQUIREMENT =
  "must be cache:// followed by 64 lowercase hexadecimal characters";

export type CacheHandleParseResult =
  | { ok: true; handle: string; sha256: string }
  | { ok: false; message: string };

export function renderCacheHandle(sha256: string): string {
  const normalized = sha256.trim().toLowerCase();
  if (!RENDER_SHA256_RE.test(normalized)) {
    throw new Error(`invalid cache sha256: ${INVALID_HANDLE_REQUIREMENT}`);
  }
  return `${HANDLE_PREFIX}${normalized}`;
}

export function parseCacheHandle(value: string): CacheHandleParseResult {
  const trimmed = value.trim();
  if (!trimmed.startsWith(HANDLE_PREFIX)) {
    return invalidCacheHandle(trimmed);
  }

  const sha256 = trimmed.slice(HANDLE_PREFIX.length);
  if (!SHA256_HEX_RE.test(sha256)) {
    return invalidCacheHandle(trimmed);
  }

  return { ok: true, handle: renderCacheHandle(sha256), sha256 };
}

export function describeInvalidCacheHandle(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length > MAX_DESCRIBED_VALUE_CHARS) {
    return `value with length ${trimmed.length}`;
  }
  return trimmed;
}

function invalidCacheHandle(value: string): CacheHandleParseResult {
  return {
    ok: false,
    message: `invalid cache handle (${describeInvalidCacheHandle(value)}): ${INVALID_HANDLE_REQUIREMENT}`,
  };
}
