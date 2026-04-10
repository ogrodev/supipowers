import { describe, expect, mock, test } from "bun:test";
import type { Platform } from "../../src/platform/types.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type { ReviewReport, SupipowersConfig } from "../../src/types.js";
import { handleReview, registerReviewCommand } from "../../src/commands/review.js";

function createConfig(overrides: Partial<SupipowersConfig> = {}): SupipowersConfig {
  return {
    ...DEFAULT_CONFIG,
    quality: {
      gates: {},
      ...overrides.quality,
    },
    ...overrides,
  };
}

function createReport(overrides: Partial<ReviewReport> = {}): ReviewReport {
  return {
    timestamp: "2026-04-10T00:00:00.000Z",
    selectedGates: ["lsp-diagnostics"],
    gates: [
      {
        gate: "lsp-diagnostics",
        status: "passed",
        summary: "ok",
        issues: [],
      },
    ],
    summary: { passed: 1, failed: 0, skipped: 0, blocked: 0 },
    overallStatus: "passed",
    ...overrides,
  };
}

function createPlatform(): Platform {
  return {
    name: "omp",
    registerCommand: mock(),
    getCommands: mock(() => []),
    on: mock(),
    exec: mock(),
    sendMessage: mock(),
    sendUserMessage: mock(),
    getActiveTools: mock(() => []),
    registerMessageRenderer: mock(),
    createAgentSession: mock(),
    paths: {
      dotDir: ".omp",
      dotDirDisplay: ".omp",
      project: (_cwd: string, ...segments: string[]) => segments.join("/"),
      global: (...segments: string[]) => segments.join("/"),
      agent: (...segments: string[]) => segments.join("/"),
    },
    capabilities: {
      agentSessions: true,
      compactionHooks: false,
      customWidgets: false,
      registerTool: false,
    },
  } as unknown as Platform;
}

function createContext() {
  return {
    cwd: "/repo",
    hasUI: true,
    ui: { notify: mock() },
    modelRegistry: { getAvailable: () => [] },
  } as any;
}

function createDependencies(config: SupipowersConfig, report = createReport()) {
  return {
    loadModelConfig: mock(() => ({ version: "1.0.0", default: null, actions: {} })),
    createModelBridge: mock(() => ({ getModelForRole: () => null, getCurrentModel: () => "unknown" })),
    resolveModelForAction: mock(() => ({ model: "claude-opus-4-6", thinkingLevel: "high", source: "action" })),
    applyModelOverride: mock(async () => true),
    loadConfig: mock(() => config),
    runQualityGates: mock(async () => report),
    saveReviewReport: mock(() => "/repo/.omp/supipowers/reports/review-2026-04-10.json"),
    notifyInfo: mock(),
  };
}

describe("handleReview", () => {
  test("rejects mixed --only and --skip", async () => {
    const platform = createPlatform();
    const ctx = createContext();
    const deps = createDependencies(
      createConfig({ quality: { gates: { "ai-review": { enabled: true, depth: "deep" } } } }),
    );

    await expect(handleReview(platform, ctx, "--only ai-review --skip test-suite", deps)).rejects.toThrow(
      /mutually exclusive/i,
    );
  });

  test("rejects unknown gate ids", async () => {
    const platform = createPlatform();
    const ctx = createContext();
    const deps = createDependencies(
      createConfig({ quality: { gates: { "ai-review": { enabled: true, depth: "deep" } } } }),
    );

    await expect(handleReview(platform, ctx, "--only does-not-exist", deps)).rejects.toThrow(/unknown gate/i);
  });

  test("rejects disabled gate ids", async () => {
    const platform = createPlatform();
    const ctx = createContext();
    const deps = createDependencies(
      createConfig({ quality: { gates: { "lsp-diagnostics": { enabled: true } } } }),
    );

    await expect(handleReview(platform, ctx, "--only ai-review", deps)).rejects.toThrow(/disabled|not configured/i);
  });

  test("stops when no gates are configured", async () => {
    const platform = createPlatform();
    const ctx = createContext();
    const deps = createDependencies(createConfig({ quality: { gates: {} } }));

    await expect(handleReview(platform, ctx, "", deps)).rejects.toThrow(/No quality gates configured/i);
  });

  test("stops when filters leave zero selected gates", async () => {
    const platform = createPlatform();
    const ctx = createContext();
    const deps = createDependencies(
      createConfig({ quality: { gates: { "lsp-diagnostics": { enabled: true } } } }),
    );

    await expect(handleReview(platform, ctx, "--skip lsp-diagnostics", deps)).rejects.toThrow(/no selected gates/i);
  });

  test("summary includes skipped gates in canonical order", async () => {
    const platform = createPlatform();
    const ctx = createContext();
    const deps = createDependencies(
      createConfig({
        quality: {
          gates: {
            "lsp-diagnostics": { enabled: true },
            "ai-review": { enabled: true, depth: "deep" },
          },
        },
      }),
      createReport({
        selectedGates: ["lsp-diagnostics", "ai-review"],
        gates: [
          { gate: "lsp-diagnostics", status: "passed", summary: "ok", issues: [] },
          { gate: "ai-review", status: "skipped", summary: "Skipped by filter", issues: [] },
        ],
        summary: { passed: 1, failed: 0, skipped: 1, blocked: 0 },
        overallStatus: "passed",
      }),
    );

    await handleReview(platform, ctx, "--skip ai-review", deps);

    expect(deps.notifyInfo).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.stringContaining("ai-review: skipped"),
    );
  });

  test("persists report and notifies summary details", async () => {
    const platform = createPlatform();
    const ctx = createContext();
    const deps = createDependencies(
      createConfig({ quality: { gates: { "lsp-diagnostics": { enabled: true } } } }),
    );

    await handleReview(platform, ctx, "", deps);

    expect(deps.saveReviewReport).toHaveBeenCalled();
    expect(deps.notifyInfo).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("Review complete"),
      expect.stringContaining("saved:"),
    );
  });
});

describe("registerReviewCommand", () => {
  test("description no longer advertises review profiles", () => {
    const platform = createPlatform();

    registerReviewCommand(platform);

    expect(platform.registerCommand).toHaveBeenCalledWith(
      "supi:review",
      expect.objectContaining({ description: "Run configured quality gates" }),
    );
  });
});
