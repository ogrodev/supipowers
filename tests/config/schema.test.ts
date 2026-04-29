import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { validateConfig } from "../../src/config/schema.js";
import type { SupipowersConfig, UltraPlanReviewerSlotName, UltraPlanSlotOverride } from "../../src/types.js";

const rootUltraPlanConfigFixture = {
  ...DEFAULT_CONFIG,
  ultraplan: {
    slots: {
      "backend-tester": {
        agentName: "integration-breaker",
      },
    },
    reviewGates: {
      "frontend-domain-reviewer": {
        enabled: true,
      },
    },
  },
} satisfies SupipowersConfig;

const sparseUltraPlanOverride = {
  thinkingLevel: "low",
} satisfies UltraPlanSlotOverride;

const invalidReviewerGateSlots = {
  // @ts-expect-error reviewer gates are reviewer-slot only
  "frontend-executor": { enabled: true },
} satisfies Partial<Record<UltraPlanReviewerSlotName, { enabled: boolean }>>;

void rootUltraPlanConfigFixture;
void sparseUltraPlanOverride;
void invalidReviewerGateSlots;


describe("validateConfig", () => {
  test("accepts the default config", () => {
    expect(validateConfig(DEFAULT_CONFIG)).toEqual({ valid: true, errors: [] });
  });

  test("accepts ultraplan slot overrides for named agents", () => {
    const result = validateConfig({
      ...DEFAULT_CONFIG,
      ultraplan: {
        slots: {
          "backend-tester": {
            agentName: "integration-breaker",
          },
        },
      },
    } as unknown);

    expect(result).toEqual({ valid: true, errors: [] });
  });

  test("accepts ultraplan slot overrides with only thinkingLevel", () => {
    const result = validateConfig({
      ...DEFAULT_CONFIG,
      ultraplan: {
        slots: {
          "frontend-executor": {
            thinkingLevel: "low",
          },
        },
      },
    } as unknown);

    expect(result).toEqual({ valid: true, errors: [] });
  });

  test("rejects ultraplan reviewer gates for executor slots", () => {
    const result = validateConfig({
      ...DEFAULT_CONFIG,
      ultraplan: {
        reviewGates: {
          "frontend-executor": {
            enabled: true,
          },
        },
      },
    } as unknown);

    expect(result.valid).toBe(false);
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

  test("accepts target-aware command gate runs", () => {
    const result = validateConfig({
      ...DEFAULT_CONFIG,
      quality: {
        gates: {
          lint: {
            enabled: true,
            runs: [
              { command: "eslint .", target: { scope: "all-targets" } },
              { command: "eslint .", target: { scope: "workspace", relativeDir: "packages/web" } },
            ],
          },
        },
      },
    });

    expect(result).toEqual({ valid: true, errors: [] });
  });

  test("rejects legacy single-command gate shape without migration", () => {
    const result = validateConfig({
      ...DEFAULT_CONFIG,
      quality: {
        gates: {
          lint: { enabled: true, command: "eslint ." },
        },
      },
    } as unknown);

    expect(result.valid).toBe(false);
  });


  test("rejects malformed lazy-tools config", () => {
    const result = validateConfig({
      ...DEFAULT_CONFIG,
      contextMode: {
        ...DEFAULT_CONFIG.contextMode,
        lazyTools: {
          ...DEFAULT_CONFIG.contextMode.lazyTools,
          mode: "reckless",
          unexpected: true,
        },
      },
    } as unknown);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes("contextMode.lazyTools.mode"))).toBe(true);
    expect(result.errors.some((error) => error.includes("contextMode.lazyTools"))).toBe(true);
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
