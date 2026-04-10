import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { validateConfig } from "../../src/config/schema.js";

describe("validateConfig", () => {
  test("accepts the default config", () => {
    expect(validateConfig(DEFAULT_CONFIG)).toEqual({ valid: true, errors: [] });
  });

  test("rejects unknown gate ids", () => {
    const result = validateConfig({
      ...DEFAULT_CONFIG,
      quality: { gates: { "unknown-gate": { enabled: true } } },
    });

    expect(result.valid).toBe(false);
  });

  test("rejects removed profile-era fields", () => {
    const result = validateConfig({
      ...DEFAULT_CONFIG,
      defaultProfile: "thorough",
    } as unknown);

    expect(result.valid).toBe(false);
  });

  test("rejects legacy qa.command as a shared review input", () => {
    const result = validateConfig({
      ...DEFAULT_CONFIG,
      qa: { framework: null, e2e: false, command: "npm test" },
    } as unknown);

    expect(result.valid).toBe(false);
  });
});
