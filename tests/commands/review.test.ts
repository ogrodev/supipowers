import { describe, expect, mock, test } from "bun:test";
import type { Platform } from "../../src/platform/types.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type { InspectionLoadResult } from "../../src/config/schema.js";
import type { ConfigScope, ReviewReport, SupipowersConfig } from "../../src/types.js";
import { handleReview, registerReviewCommand } from "../../src/commands/review.js";
import type { ReviewCommandDependencies } from "../../src/commands/review.js";

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

function createInspection(config: SupipowersConfig = DEFAULT_CONFIG): InspectionLoadResult {
  return {
    mergedConfig: config as unknown as Record<string, unknown>,
    effectiveConfig: config,
    parseErrors: [],
    validationErrors: [],
  };
}

function createScopeInspection(scope: ConfigScope, overrides: Record<string, unknown> = {}) {
  return {
    scope,
    path: `/${scope}/config.json`,
    data: null,
    parseError: null,
    validationErrors: [],
    qualityGateValidationErrors: [],
    otherValidationErrors: [],
    hasOwnQualityGates: false,
    recoverableInvalidQualityGates: false,
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
    ui: {
      notify: mock(),
      select: mock(),
      input: mock(),
      setStatus: mock(),
      setWidget: mock(),
    },
    modelRegistry: { getAvailable: () => [] },
  } as any;
}

function createDependencies(
  config: SupipowersConfig,
  report = createReport(),
): ReviewCommandDependencies {
  return {
    loadModelConfig: mock(() => ({ version: "1.0.0", default: null, actions: {} })),
    createModelBridge: mock(() => ({ getModelForRole: () => null, getCurrentModel: () => "unknown" })),
    resolveModelForAction: mock(() => ({
      model: "claude-opus-4-6",
      thinkingLevel: "high" as const,
      source: "action" as const,
    })),
    applyModelOverride: mock(async () => true),
    inspectConfig: mock(() => createInspection(config)),
    inspectQualityGateRecovery: mock(() => ({ scopes: [] })),
    loadConfig: mock(() => config),
    removeQualityGatesConfig: mock(() => true),
    setupGates: mock(async () => ({
      status: "proposed" as const,
      proposal: { gates: config.quality.gates },
    })),
    interactivelySaveGateSetup: mock(async () => "saved" as const),
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

  test("recovers invalid project quality.gates, launches setup, and resumes review", async () => {
    const platform = createPlatform();
    const ctx = createContext();
    const recoveredConfig = createConfig({
      quality: { gates: { "test-suite": { enabled: true, command: "bun test" } } },
    });
    const deps = createDependencies(recoveredConfig);
    deps.loadConfig = mock()
      .mockImplementationOnce(() => {
        throw new Error("quality.gates.ai-review.depth: Expected union value");
      })
      .mockImplementation(() => recoveredConfig);
    deps.inspectConfig = mock(() => createInspection(recoveredConfig));
    deps.inspectQualityGateRecovery = mock(() => ({
      scopes: [
        createScopeInspection("global"),
        createScopeInspection("project", {
          hasOwnQualityGates: true,
          recoverableInvalidQualityGates: true,
          qualityGateValidationErrors: [
            { path: "quality.gates.ai-review.depth", message: "Expected union value" },
          ],
          validationErrors: [
            { path: "quality.gates.ai-review.depth", message: "Expected union value" },
          ],
        }),
      ],
    }));

    await handleReview(platform, ctx, "", deps);

    expect(deps.removeQualityGatesConfig).toHaveBeenCalledWith(platform.paths, ctx.cwd, "project");
    expect(deps.setupGates).toHaveBeenCalledWith(
      platform,
      ctx.cwd,
      expect.anything(),
      { mode: "deterministic" },
    );
    expect(deps.interactivelySaveGateSetup).toHaveBeenCalled();
    expect(deps.runQualityGates).toHaveBeenCalledWith(
      expect.objectContaining({ gates: recoveredConfig.quality.gates }),
    );
    expect(deps.notifyInfo).toHaveBeenCalledWith(
      ctx,
      "Removed invalid review config",
      expect.stringContaining("project config"),
    );
  });

  test("recovers invalid global quality.gates and cleans only the global scope", async () => {
    const platform = createPlatform();
    const ctx = createContext();
    const recoveredConfig = createConfig({
      quality: { gates: { "ai-review": { enabled: true, depth: "deep" } } },
    });
    const deps = createDependencies(recoveredConfig);
    deps.loadConfig = mock()
      .mockImplementationOnce(() => {
        throw new Error("quality.gates.test-suite.command: Expected string");
      })
      .mockImplementation(() => recoveredConfig);
    deps.inspectQualityGateRecovery = mock(() => ({
      scopes: [
        createScopeInspection("global", {
          hasOwnQualityGates: true,
          recoverableInvalidQualityGates: true,
          qualityGateValidationErrors: [
            { path: "quality.gates.test-suite.command", message: "Expected string" },
          ],
          validationErrors: [
            { path: "quality.gates.test-suite.command", message: "Expected string" },
          ],
        }),
        createScopeInspection("project"),
      ],
    }));

    await handleReview(platform, ctx, "", deps);

    expect(deps.removeQualityGatesConfig).toHaveBeenCalledTimes(1);
    expect(deps.removeQualityGatesConfig).toHaveBeenCalledWith(platform.paths, ctx.cwd, "global");
  });

  test("cleans both scopes when both contain invalid quality.gates", async () => {
    const platform = createPlatform();
    const ctx = createContext();
    const recoveredConfig = createConfig({
      quality: { gates: { "lsp-diagnostics": { enabled: true } } },
    });
    const deps = createDependencies(recoveredConfig);
    deps.loadConfig = mock()
      .mockImplementationOnce(() => {
        throw new Error("quality.gates: invalid");
      })
      .mockImplementation(() => recoveredConfig);
    deps.inspectQualityGateRecovery = mock(() => ({
      scopes: [
        createScopeInspection("global", {
          hasOwnQualityGates: true,
          recoverableInvalidQualityGates: true,
          qualityGateValidationErrors: [{ path: "quality.gates", message: "Expected object" }],
          validationErrors: [{ path: "quality.gates", message: "Expected object" }],
        }),
        createScopeInspection("project", {
          hasOwnQualityGates: true,
          recoverableInvalidQualityGates: true,
          qualityGateValidationErrors: [{ path: "quality.gates.ai-review.depth", message: "Expected union value" }],
          validationErrors: [{ path: "quality.gates.ai-review.depth", message: "Expected union value" }],
        }),
      ],
    }));

    await handleReview(platform, ctx, "", deps);

    expect(deps.removeQualityGatesConfig).toHaveBeenCalledTimes(2);
    expect(deps.removeQualityGatesConfig).toHaveBeenCalledWith(platform.paths, ctx.cwd, "global");
    expect(deps.removeQualityGatesConfig).toHaveBeenCalledWith(platform.paths, ctx.cwd, "project");
  });

  test("preserves strict failure for unrelated config errors", async () => {
    const platform = createPlatform();
    const ctx = createContext();
    const deps = createDependencies(createConfig());
    deps.loadConfig = mock(() => {
      throw new Error("notifications.verbosity: Expected union value");
    });
    deps.inspectQualityGateRecovery = mock(() => ({
      scopes: [
        createScopeInspection("project", {
          otherValidationErrors: [{ path: "notifications.verbosity", message: "Expected union value" }],
          validationErrors: [{ path: "notifications.verbosity", message: "Expected union value" }],
        }),
      ],
    }));

    await expect(handleReview(platform, ctx, "", deps)).rejects.toThrow(/notifications\.verbosity/i);
    expect(deps.removeQualityGatesConfig).not.toHaveBeenCalled();
    expect(deps.setupGates).not.toHaveBeenCalled();
  });

  test("stops review cleanly when setup is cancelled after cleanup", async () => {
    const platform = createPlatform();
    const ctx = createContext();
    const deps = createDependencies(
      createConfig({ quality: { gates: { "ai-review": { enabled: true, depth: "deep" } } } }),
    );
    deps.loadConfig = mock(() => {
      throw new Error("quality.gates.ai-review.depth: Expected union value");
    });
    deps.inspectQualityGateRecovery = mock(() => ({
      scopes: [
        createScopeInspection("project", {
          hasOwnQualityGates: true,
          recoverableInvalidQualityGates: true,
          qualityGateValidationErrors: [
            { path: "quality.gates.ai-review.depth", message: "Expected union value" },
          ],
          validationErrors: [
            { path: "quality.gates.ai-review.depth", message: "Expected union value" },
          ],
        }),
      ],
    }));
    deps.interactivelySaveGateSetup = mock(async () => "cancelled" as const);

    await handleReview(platform, ctx, "", deps);

    expect(deps.runQualityGates).not.toHaveBeenCalled();
    expect(deps.notifyInfo).toHaveBeenLastCalledWith(
      ctx,
      "Review cancelled",
      expect.stringContaining("setup was cancelled"),
    );
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

  test("shows review progress for configured, skipped, and completed gates", async () => {
    const platform = createPlatform();
    const ctx = createContext();
    const deps = createDependencies(
      createConfig({
        quality: {
          gates: {
            "lsp-diagnostics": { enabled: true },
            "test-suite": { enabled: true, command: "bun test" },
          },
        },
      }),
      createReport({
        selectedGates: ["lsp-diagnostics", "test-suite"],
        gates: [
          { gate: "lsp-diagnostics", status: "passed", summary: "No diagnostics", issues: [] },
          { gate: "test-suite", status: "skipped", summary: "Skipped by filter", issues: [] },
        ],
        summary: { passed: 1, failed: 0, skipped: 1, blocked: 0 },
        overallStatus: "passed",
      }),
    );
    deps.runQualityGates = mock(async (input) => {
      input.onEvent?.({
        type: "scope-discovered",
        changedFiles: 2,
        scopeFiles: 2,
        fileScope: "changed-files",
      });
      input.onEvent?.({ type: "gate-started", gateId: "lsp-diagnostics" });
      input.onEvent?.({
        type: "gate-completed",
        gateId: "lsp-diagnostics",
        status: "passed",
        summary: "No diagnostics",
      });
      input.onEvent?.({ type: "gate-skipped", gateId: "test-suite", reason: "Skipped by filter" });
      return createReport({
        selectedGates: ["lsp-diagnostics", "test-suite"],
        gates: [
          { gate: "lsp-diagnostics", status: "passed", summary: "No diagnostics", issues: [] },
          { gate: "test-suite", status: "skipped", summary: "Skipped by filter", issues: [] },
        ],
        summary: { passed: 1, failed: 0, skipped: 1, blocked: 0 },
        overallStatus: "passed",
      });
    }) as typeof deps.runQualityGates;

    await handleReview(platform, ctx, "--skip test-suite", deps);

    const widgetSnapshots = ctx.ui.setWidget.mock.calls
      .filter(([key, value]: [string, unknown]) => key === "supi-review" && Array.isArray(value))
      .map(([, value]: [string, string[]]) => value.join("\n"));

    expect(widgetSnapshots.some((snapshot: string) => snapshot.includes("Load config (loaded)"))).toBe(true);
    expect(widgetSnapshots.some((snapshot: string) => snapshot.includes("Discover review scope (2 changed file(s))"))).toBe(true);
    expect(widgetSnapshots.some((snapshot: string) => snapshot.includes("LSP diagnostics (No diagnostics)"))).toBe(true);
    expect(widgetSnapshots.some((snapshot: string) => snapshot.includes("Test suite (Skipped by filter)"))).toBe(true);
    expect(widgetSnapshots.some((snapshot: string) => snapshot.includes("AI review (not configured)"))).toBe(true);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("supi-review", expect.stringContaining("Writing report"));
    expect(ctx.ui.setWidget).toHaveBeenCalledWith("supi-review", undefined);
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
