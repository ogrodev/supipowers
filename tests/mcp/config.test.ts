// tests/mcp/config.test.ts
import { describe, it, expect } from "vitest";
import { isValidServerName, createEmptyRegistry } from "../../src/mcp/types.js";

describe("isValidServerName", () => {
  it("accepts valid names", () => {
    expect(isValidServerName("figma").valid).toBe(true);
    expect(isValidServerName("my-server").valid).toBe(true);
    expect(isValidServerName("s3").valid).toBe(true);
  });

  it("rejects names starting/ending with hyphen", () => {
    expect(isValidServerName("-figma").valid).toBe(false);
    expect(isValidServerName("figma-").valid).toBe(false);
  });

  it("rejects uppercase", () => {
    expect(isValidServerName("Figma").valid).toBe(false);
  });

  it("rejects reserved names", () => {
    const r = isValidServerName("path");
    expect(r.valid).toBe(false);
    expect(r.reason).toContain("reserved");
  });

  it("rejects empty and too-long names", () => {
    expect(isValidServerName("").valid).toBe(false);
    expect(isValidServerName("a".repeat(64)).valid).toBe(false);
  });

  it("accepts max-length name", () => {
    expect(isValidServerName("a".repeat(63)).valid).toBe(true);
  });
});

describe("createEmptyRegistry", () => {
  it("returns fresh registry each time", () => {
    const a = createEmptyRegistry();
    const b = createEmptyRegistry();
    expect(a.schemaVersion).toBe(1);
    expect(a.servers).toEqual({});
    expect(a).not.toBe(b); // new object each call
  });
});
