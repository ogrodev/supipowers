// tests/context-mode/cache-handle.test.ts
import { describe, expect, test } from "bun:test";
import {
  describeInvalidCacheHandle,
  parseCacheHandle,
  renderCacheHandle,
} from "../../src/context-mode/cache-handle.js";

const SHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("cache handle helpers", () => {
  test("valid lowercase handles parse and render canonically", () => {
    const handle = `cache://${SHA}`;

    expect(renderCacheHandle(SHA)).toBe(handle);
    expect(parseCacheHandle(handle)).toEqual({ ok: true, handle, sha256: SHA });
  });

  test("parse trims surrounding whitespace", () => {
    expect(parseCacheHandle(` \n\tcache://${SHA}\r\n `)).toEqual({
      ok: true,
      handle: `cache://${SHA}`,
      sha256: SHA,
    });
  });

  test("uppercase hashes are rejected", () => {
    const result = parseCacheHandle(`cache://${SHA.toUpperCase()}`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("invalid cache handle");
      expect(result.message).toContain("must be cache:// followed by 64 lowercase hexadecimal characters");
    }
  });

  test("wrong schemes are rejected", () => {
    expect(parseCacheHandle(`file://${SHA}`)).toEqual({
      ok: false,
      message:
        "invalid cache handle (file://0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef): must be cache:// followed by 64 lowercase hexadecimal characters",
    });
  });

  test("short and long hashes are rejected", () => {
    const shortResult = parseCacheHandle(`cache://${SHA.slice(0, 63)}`);
    const longResult = parseCacheHandle(`cache://${SHA}0`);

    expect(shortResult.ok).toBe(false);
    expect(longResult.ok).toBe(false);
    if (!shortResult.ok) expect(shortResult.message).toContain("invalid cache handle");
    if (!longResult.ok) expect(longResult.message).toContain("invalid cache handle");
  });

  test("non-hex characters and embedded whitespace are rejected", () => {
    const nonHex = parseCacheHandle(`cache://${SHA.slice(0, 63)}g`);
    const embeddedWhitespace = parseCacheHandle(`cache://${SHA.slice(0, 32)} ${SHA.slice(32)}`);

    expect(nonHex.ok).toBe(false);
    expect(embeddedWhitespace.ok).toBe(false);
    if (!nonHex.ok) expect(nonHex.message).toContain("invalid cache handle");
    if (!embeddedWhitespace.ok) expect(embeddedWhitespace.message).toContain("invalid cache handle");
  });

  test("long invalid values are redacted from errors", () => {
    const invalid = `cache://${"x".repeat(5000)}`;
    const result = parseCacheHandle(invalid);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("invalid cache handle");
      expect(result.message).toContain(`length ${invalid.length}`);
      expect(result.message).not.toContain("x".repeat(200));
      expect(result.message.length).toBeLessThan(240);
    }
  });

  test("describeInvalidCacheHandle redacts only large values", () => {
    expect(describeInvalidCacheHandle("cache://bad")).toBe("cache://bad");

    const invalid = "z".repeat(1000);
    expect(describeInvalidCacheHandle(invalid)).toBe("value with length 1000");
  });
});
