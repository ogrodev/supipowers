import { describe, expect, mock, test } from "bun:test";
import type { Platform } from "../../src/platform/types.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type { InspectionLoadResult } from "../../src/config/schema.js";
import type { ConfigScope, ReviewReport, SupipowersConfig } from "../../src/types.js";
import { buildFailureSummary, filterTestRunnerOutput, handleChecks, registerChecksCommand } from "../../src/commands/review.js";
import type { ChecksCommandDependencies } from "../../src/commands/review.js";

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
): ChecksCommandDependencies {
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

describe("handleChecks", () => {
  test("rejects mixed --only and --skip", async () => {
    const platform = createPlatform();
    const ctx = createContext();
    const deps = createDependencies(
      createConfig({ quality: { gates: { "lint": { enabled: true, command: "eslint ." } } } }),
    );

    await expect(handleChecks(platform, ctx, "--only lint --skip test-suite", deps)).rejects.toThrow(
      /mutually exclusive/i,
    );
  });

  test("rejects unknown gate ids", async () => {
    const platform = createPlatform();
    const ctx = createContext();
    const deps = createDependencies(
      createConfig({ quality: { gates: { "lint": { enabled: true, command: "eslint ." } } } }),
    );

    await expect(handleChecks(platform, ctx, "--only does-not-exist", deps)).rejects.toThrow(/unknown gate/i);
  });

  test("rejects disabled gate ids", async () => {
    const platform = createPlatform();
    const ctx = createContext();
    const deps = createDependencies(
      createConfig({ quality: { gates: { "lsp-diagnostics": { enabled: true } } } }),
    );

    await expect(handleChecks(platform, ctx, "--only lint", deps)).rejects.toThrow(/disabled|not configured/i);
  });

  test("stops when no gates are configured", async () => {
    const platform = createPlatform();
    const ctx = createContext();
    const deps = createDependencies(createConfig({ quality: { gates: {} } }));

    await expect(handleChecks(platform, ctx, "", deps)).rejects.toThrow(/No quality gates configured/i);
  });

  test("stops when filters leave zero selected gates", async () => {
    const platform = createPlatform();
    const ctx = createContext();
    const deps = createDependencies(
      createConfig({ quality: { gates: { "lsp-diagnostics": { enabled: true } } } }),
    );

    await expect(handleChecks(platform, ctx, "--skip lsp-diagnostics", deps)).rejects.toThrow(/no selected gates/i);
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
        throw new Error("quality.gates.lint.command: Expected union value");
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
            { path: "quality.gates.lint.command", message: "Expected union value" },
          ],
          validationErrors: [
            { path: "quality.gates.lint.command", message: "Expected union value" },
          ],
        }),
      ],
    }));

    await handleChecks(platform, ctx, "", deps);

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
      quality: { gates: { "lint": { enabled: true, command: "eslint ." } } },
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

    await handleChecks(platform, ctx, "", deps);

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
          qualityGateValidationErrors: [{ path: "quality.gates.lint.command", message: "Expected union value" }],
          validationErrors: [{ path: "quality.gates.lint.command", message: "Expected union value" }],
        }),
      ],
    }));

    await handleChecks(platform, ctx, "", deps);

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

    await expect(handleChecks(platform, ctx, "", deps)).rejects.toThrow(/notifications\.verbosity/i);
    expect(deps.removeQualityGatesConfig).not.toHaveBeenCalled();
    expect(deps.setupGates).not.toHaveBeenCalled();
  });

  test("stops review cleanly when setup is cancelled after cleanup", async () => {
    const platform = createPlatform();
    const ctx = createContext();
    const deps = createDependencies(
      createConfig({ quality: { gates: { "lint": { enabled: true, command: "eslint ." } } } }),
    );
    deps.loadConfig = mock(() => {
      throw new Error("quality.gates.lint.command: Expected union value");
    });
    deps.inspectQualityGateRecovery = mock(() => ({
      scopes: [
        createScopeInspection("project", {
          hasOwnQualityGates: true,
          recoverableInvalidQualityGates: true,
          qualityGateValidationErrors: [
            { path: "quality.gates.lint.command", message: "Expected union value" },
          ],
          validationErrors: [
            { path: "quality.gates.lint.command", message: "Expected union value" },
          ],
        }),
      ],
    }));
    deps.interactivelySaveGateSetup = mock(async () => "cancelled" as const);

    await handleChecks(platform, ctx, "", deps);

    expect(deps.runQualityGates).not.toHaveBeenCalled();
    expect(deps.notifyInfo).toHaveBeenLastCalledWith(
      ctx,
      "Checks cancelled",
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
            "lint": { enabled: true, command: "eslint ." },
          },
        },
      }),
      createReport({
        selectedGates: ["lsp-diagnostics", "lint"],
        gates: [
          { gate: "lsp-diagnostics", status: "passed", summary: "ok", issues: [] },
          { gate: "lint", status: "skipped", summary: "Skipped by filter", issues: [] },
        ],
        summary: { passed: 1, failed: 0, skipped: 1, blocked: 0 },
        overallStatus: "passed",
      }),
    );

    await handleChecks(platform, ctx, "--skip lint", deps);

    expect(deps.notifyInfo).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.stringContaining("lint: skipped"),
    );
  });

  test("persists report and notifies summary details", async () => {
    const platform = createPlatform();
    const ctx = createContext();
    const deps = createDependencies(
      createConfig({ quality: { gates: { "lsp-diagnostics": { enabled: true } } } }),
    );

    await handleChecks(platform, ctx, "", deps);

    expect(deps.saveReviewReport).toHaveBeenCalled();
    expect(deps.notifyInfo).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("Checks complete"),
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

    await handleChecks(platform, ctx, "--skip test-suite", deps);

    const widgetSnapshots = ctx.ui.setWidget.mock.calls
      .filter(([key, value]: [string, unknown]) => key === "supi-review" && typeof value === "function")
      .map(([, factory]: [string, () => { getText(): string }]) => factory().getText());

    expect(widgetSnapshots.some((snapshot: string) => snapshot.includes("Load config (loaded)"))).toBe(true);
    expect(widgetSnapshots.some((snapshot: string) => snapshot.includes("Discover review scope (2 changed file(s))"))).toBe(true);
    expect(widgetSnapshots.some((snapshot: string) => snapshot.includes("LSP diagnostics (No diagnostics)"))).toBe(true);
    // test-suite is --skip'd and non-configured gates are hidden from the widget
    expect(widgetSnapshots.every((snapshot: string) => !snapshot.includes("Test suite"))).toBe(true);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("supi-review", expect.stringContaining("Running checks..."));
    expect(ctx.ui.setWidget).toHaveBeenCalledWith("supi-review", undefined);
  });
});

describe("registerChecksCommand", () => {
  test("description no longer advertises review profiles", () => {
    const platform = createPlatform();

    registerChecksCommand(platform);

    expect(platform.registerCommand).toHaveBeenCalledWith(
      "supi:checks",
      expect.objectContaining({ description: "Run configured quality gates" }),
    );
  });
});


describe("buildFailureSummary", () => {
  test("formats error-severity issues per gate with file locations", () => {
    const result = buildFailureSummary([
      {
        gate: "typecheck",
        status: "failed",
        summary: "3 errors",
        issues: [
          { severity: "error", message: "Type 'string' is not assignable to 'number'", file: "src/foo.ts", line: 42 },
          { severity: "error", message: "Property 'bar' does not exist", file: "src/bar.ts" },
          { severity: "warning", message: "Unused variable", file: "src/foo.ts", line: 10 },
        ],
      },
    ]);

    expect(result).toContain("Typecheck (2 errors):");
    expect(result).toContain("src/foo.ts:42");
    expect(result).toContain("src/bar.ts");
    expect(result).not.toContain("Unused variable");
  });

  test("shows gate summary when no error-level issues exist", () => {
    const result = buildFailureSummary([
      {
        gate: "build",
        status: "blocked",
        summary: "Build tool not found",
        issues: [],
      },
    ]);

    expect(result).toBe("Build: Build tool not found");
  });

  test("formats multiple failed gates separated by blank lines", () => {
    const result = buildFailureSummary([
      {
        gate: "lint",
        status: "failed",
        summary: "1 error",
        issues: [{ severity: "error", message: "no-console violation" }],
      },
      {
        gate: "test-suite",
        status: "failed",
        summary: "2 failures",
        issues: [
          { severity: "error", message: "test 'handles edge case' failed", file: "tests/edge.test.ts", line: 15 },
          { severity: "error", message: "test 'validates input' failed", file: "tests/input.test.ts", line: 8 },
        ],
      },
    ]);

    expect(result).toContain("Lint (1 error):");
    expect(result).toContain("Test suite (2 errors):");
    expect(result).toContain("tests/edge.test.ts:15");
    expect(result).toContain("\n\n");
  });
});

describe("filterTestRunnerOutput", () => {
  test("strips bun:test passing lines and keeps failures", () => {
    const output = [
      "(pass) handles edge case [0.12ms]",
      "(pass) validates input [0.03ms]",
      "(fail) rejects bad data [0.45ms]",
      "  Error: expected 1 to equal 2",
      "    at tests/foo.test.ts:42:5",
      "(pass) serializes output [0.01ms]",
      "",
      "2 pass",
      "1 fail",
    ].join("\n");

    const result = filterTestRunnerOutput(output);

    expect(result).not.toContain("(pass)");
    expect(result).toContain("(fail) rejects bad data");
    expect(result).toContain("expected 1 to equal 2");
    expect(result).toContain("tests/foo.test.ts:42:5");
    expect(result).toContain("1 fail");
  });

  test("strips jest/mocha checkmark passing lines", () => {
    const output = [
      "  \u2713 should add numbers (3ms)",
      "  \u2713 should subtract numbers",
      "  \u2715 should divide by zero",
      "    Error: division by zero",
    ].join("\n");

    const result = filterTestRunnerOutput(output);

    expect(result).not.toContain("\u2713");
    expect(result).toContain("\u2715 should divide by zero");
    expect(result).toContain("division by zero");
  });

  test("strips pytest PASSED lines and keeps FAILED", () => {
    const output = [
      "test_math.py::test_add PASSED",
      "test_math.py::test_sub PASSED",
      "test_math.py::test_div FAILED",
      "    assert 1 / 0",
      "    ZeroDivisionError: division by zero",
      "",
      "======= 1 failed, 2 passed =======",
    ].join("\n");

    const result = filterTestRunnerOutput(output);

    expect(result).not.toContain("test_add PASSED");
    expect(result).not.toContain("test_sub PASSED");
    expect(result).toContain("test_div FAILED");
    expect(result).toContain("ZeroDivisionError");
    expect(result).toContain("1 failed, 2 passed");
  });

  test("strips jest PASS file-level lines", () => {
    const output = [
      "PASS src/utils.test.ts",
      "FAIL src/broken.test.ts",
      "  \u25cf should work",
      "    expect(true).toBe(false)",
    ].join("\n");

    const result = filterTestRunnerOutput(output);

    expect(result).not.toContain("PASS src/utils.test.ts");
    expect(result).toContain("FAIL src/broken.test.ts");
    expect(result).toContain("expect(true).toBe(false)");
  });

  test("collapses excessive blank lines", () => {
    const output = "line1\n\n\n\n\nline2";
    const result = filterTestRunnerOutput(output);
    expect(result).toBe("line1\n\nline2");
  });

  test("returns original content for non-test output", () => {
    const output = "error TS2322: Type 'string' is not assignable to type 'number'.\n  src/foo.ts(42,5)";
    const result = filterTestRunnerOutput(output);
    expect(result).toBe(output);
  });
});

describe("handleChecks fix-offer", () => {
  test("offers to fix when gates fail and sends steer on accept", async () => {
    const platform = createPlatform();
    const ctx = createContext();
    const failedReport = createReport({
      gates: [
        { gate: "typecheck", status: "failed", summary: "2 errors", issues: [
          { severity: "error", message: "Type error in foo.ts", file: "src/foo.ts", line: 10 },
        ]},
        { gate: "build", status: "passed", summary: "ok", issues: [] },
      ],
      summary: { passed: 1, failed: 1, skipped: 0, blocked: 0 },
      overallStatus: "failed",
    });
    const deps = createDependencies(
      createConfig({ quality: { gates: { typecheck: { enabled: true, command: "tsc --noEmit" }, build: { enabled: true, command: "tsc" } } } }),
      failedReport,
    );

    ctx.ui.select = mock(async () => "Yes, fix Typecheck");

    await handleChecks(platform, ctx, "", deps);

    expect(ctx.ui.select).toHaveBeenCalledWith(
      expect.stringContaining("1 check failed"),
      expect.arrayContaining([
        expect.stringContaining("Yes, fix"),
        "No, just save for later",
      ]),
    );

    expect(platform.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("Typecheck (failed)"),
    );
  });

  test("does not offer fix when all gates pass", async () => {
    const platform = createPlatform();
    const ctx = createContext();
    const deps = createDependencies(
      createConfig({ quality: { gates: { build: { enabled: true, command: "tsc" } } } }),
      createReport({ overallStatus: "passed" }),
    );

    await handleChecks(platform, ctx, "", deps);

    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(platform.sendUserMessage).not.toHaveBeenCalled();
  });

  test("does not send steer when user declines fix", async () => {
    const platform = createPlatform();
    const ctx = createContext();
    const failedReport = createReport({
      gates: [
        { gate: "lint", status: "failed", summary: "lint errors", issues: [
          { severity: "error", message: "no-console" },
        ]},
      ],
      summary: { passed: 0, failed: 1, skipped: 0, blocked: 0 },
      overallStatus: "failed",
    });
    const deps = createDependencies(
      createConfig({ quality: { gates: { lint: { enabled: true, command: "eslint ." } } } }),
      failedReport,
    );

    ctx.ui.select = mock(async () => "No, just save for later");

    await handleChecks(platform, ctx, "", deps);

    expect(ctx.ui.select).toHaveBeenCalled();
    expect(platform.sendUserMessage).not.toHaveBeenCalled();
  });
});