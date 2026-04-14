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

  test("accepts config with customChannels", () => {
    const result = validateConfig({
      ...DEFAULT_CONFIG,
      release: {
        ...DEFAULT_CONFIG.release,
        channels: ["github", "my-forge"],
        customChannels: {
          "my-forge": {
            label: "My Forgejo",
            publishCommand: "tea release create --tag ${tag}",
            detectCommand: "tea login list",
          },
        },
      },
    });
    expect(result).toEqual({ valid: true, errors: [] });
  });

  test("accepts config with arbitrary channel strings", () => {
    const result = validateConfig({
      ...DEFAULT_CONFIG,
      release: {
        ...DEFAULT_CONFIG.release,
        channels: ["github", "gitlab", "gitea", "custom-one"],
      },
    });
    expect(result).toEqual({ valid: true, errors: [] });
  });

  test("accepts customChannels without detectCommand", () => {
    const result = validateConfig({
      ...DEFAULT_CONFIG,
      release: {
        ...DEFAULT_CONFIG.release,
        customChannels: {
          "simple": {
            label: "Simple",
            publishCommand: "echo done",
          },
        },
      },
    });
    expect(result).toEqual({ valid: true, errors: [] });
  });

  test("rejects release.tagFormat without exactly one ${version} placeholder", () => {
    const missingPlaceholder = validateConfig({
      ...DEFAULT_CONFIG,
      release: {
        ...DEFAULT_CONFIG.release,
        tagFormat: "fixed-tag",
      },
    });
    const duplicatePlaceholder = validateConfig({
      ...DEFAULT_CONFIG,
      release: {
        ...DEFAULT_CONFIG.release,
        tagFormat: "v${version}-${version}",
      },
    });

    expect(missingPlaceholder.valid).toBe(false);
    expect(duplicatePlaceholder.valid).toBe(false);
  });
});
