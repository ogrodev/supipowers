import { expect, mock } from "bun:test";
import { defineEval } from "./harness.js";
import { makeEvalContext } from "./fixtures.js";
import { handleChecks, type ChecksCommandDependencies } from "../../src/commands/review.js";
import { runQualityGates } from "../../src/quality/runner.js";
import { REVIEW_GATE_REGISTRY } from "../../src/quality/review-gates.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type { ExecOptions, ExecResult, Platform } from "../../src/platform/types.js";
import type { ReviewReport, SupipowersConfig, WorkspaceTarget } from "../../src/types.js";

function createTarget(overrides: Partial<WorkspaceTarget> = {}): WorkspaceTarget {
  const repoRoot = overrides.repoRoot ?? "/repo";
  const relativeDir = overrides.relativeDir ?? ".";
  const packageDir = overrides.packageDir ?? (relativeDir === "." ? repoRoot : `${repoRoot}/${relativeDir}`);

  return {
    id: overrides.id ?? (relativeDir === "." ? "root-app" : `pkg:${relativeDir}`),
    name: overrides.name ?? (relativeDir === "." ? "root-app" : `pkg:${relativeDir}`),
    kind: overrides.kind ?? (relativeDir === "." ? "root" : "workspace"),
    repoRoot,
    packageDir,
    manifestPath: overrides.manifestPath ?? `${packageDir}/package.json`,
    relativeDir,
    version: overrides.version ?? "1.0.0",
    private: overrides.private ?? false,
    packageManager: overrides.packageManager ?? "bun",
  };
}

function createConfig(): SupipowersConfig {
  return {
    ...DEFAULT_CONFIG,
    quality: {
      gates: {
        lint: {
          enabled: true,
          runs: [
            { command: "eslint-root", target: { scope: "root" } },
            { command: "eslint-workspace", target: { scope: "all-workspaces" } },
          ],
        },
        "test-suite": {
          enabled: true,
          runs: [
            { command: "test-alpha", target: { scope: "workspace", relativeDir: "packages/alpha" } },
          ],
        },
      },
    },
  };
}

function createPlatform(execCalls: Array<{ cmd: string; args: string[]; cwd?: string }>): Platform {
  return {
    name: "omp",
    registerCommand: mock(),
    getCommands: mock(() => []),
    on: mock(),
    exec: mock(async (cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult> => {
      execCalls.push({ cmd, args, cwd: opts?.cwd });
      const signature = args.join(" ");
      if (cmd === "git" && signature === "rev-parse --show-toplevel") {
        return { code: 0, stdout: "/repo\n", stderr: "" };
      }
      if (cmd === "git" && signature === "diff --name-only HEAD") {
        return { code: 0, stdout: "packages/alpha/src/file.ts\n", stderr: "" };
      }
      if (cmd === "git" && signature === "diff --name-only --cached") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (cmd === "git" && signature === "ls-files --others --exclude-standard") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (cmd === "git" && signature === "ls-files") {
        return {
          code: 0,
          stdout: ["packages/alpha/src/file.ts", "packages/beta/src/file.ts"].join("\n") + "\n",
          stderr: "",
        };
      }
      if ((cmd === "sh" || cmd === "cmd") && args.at(-1) === "eslint-root") {
        return { code: 0, stdout: "root ok", stderr: "" };
      }
      if ((cmd === "sh" || cmd === "cmd") && args.at(-1) === "eslint-workspace") {
        return { code: 0, stdout: "workspace ok", stderr: "" };
      }
      if ((cmd === "sh" || cmd === "cmd") && args.at(-1) === "test-alpha") {
        return { code: 0, stdout: "alpha ok", stderr: "" };
      }
      throw new Error(`Unexpected exec call: ${cmd} ${signature} @ ${opts?.cwd ?? "<none>"}`);
    }),
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

function createDependencies(config: SupipowersConfig, workspaceTargets: WorkspaceTarget[]): ChecksCommandDependencies {
  return {
    loadModelConfig: mock(() => ({ version: "1.0.0", default: null, actions: {} })),
    createModelBridge: mock(() => ({ getModelForRole: () => null, getCurrentModel: () => "unknown" })),
    resolveModelForAction: mock(() => ({
      model: "claude-opus-4-6",
      thinkingLevel: "high" as const,
      source: "action" as const,
    })),
    applyModelOverride: mock(async () => async () => {}),
    inspectConfig: mock(() => ({
      mergedConfig: config as unknown as Record<string, unknown>,
      effectiveConfig: config,
      parseErrors: [],
      validationErrors: [],
    })),
    inspectQualityGateRecovery: mock(() => ({ scopes: [] })),
    loadConfig: mock(() => config),
    removeQualityGatesConfig: mock(() => true),
    setupGates: mock(async () => ({ status: "proposed" as const, proposal: { gates: config.quality.gates } })),
    interactivelySaveGateSetup: mock(async () => "saved" as const),
    runQualityGates: runQualityGates,
    saveReviewReport: mock((_paths, target: WorkspaceTarget, report: ReviewReport) => `/reports/${target.id}-${report.overallStatus}.json`),
    resolvePackageManager: mock(() => ({
      id: "bun" as const,
      runScript: mock(),
      buildCommand: { command: "bun", args: ["run", "build"] },
    })),
    discoverWorkspaceTargets: mock(() => workspaceTargets),
    notifyInfo: mock(),
  };
}

defineEval({
  name: "checks-monorepo-target-runs",
  summary: "/supi:checks --target all runs target-aware gate commands per target and skips unmatched targets explicitly",
  regressionClass: "monorepo checks collapse to root-only commands or silently pass targets with no matching runs",
  run: async () => {
    const root = createTarget({ id: "root-app", name: "root-app" });
    const alpha = createTarget({
      id: "alpha",
      name: "alpha",
      kind: "workspace",
      relativeDir: "packages/alpha",
      packageDir: "/repo/packages/alpha",
    });
    const beta = createTarget({
      id: "beta",
      name: "beta",
      kind: "workspace",
      relativeDir: "packages/beta",
      packageDir: "/repo/packages/beta",
    });
    const config = createConfig();
    const execCalls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
    const platform = createPlatform(execCalls);
    const ctx = makeEvalContext({ hasUI: false, cwd: "/repo" });
    const deps = createDependencies(config, [root, alpha, beta]);

    await handleChecks(platform, ctx as any, "--target all", deps);

    const shellCalls = execCalls.filter((call) => call.cmd === (process.platform === "win32" ? "cmd" : "sh"));
    const executedCommands = shellCalls.map((call) => ({ cwd: call.cwd, command: call.args.at(-1) }));
    expect(executedCommands).toEqual([
      { cwd: "/repo", command: "eslint-root" },
      { cwd: "/repo/packages/alpha", command: "eslint-workspace" },
      { cwd: "/repo/packages/alpha", command: "test-alpha" },
      { cwd: "/repo/packages/beta", command: "eslint-workspace" },
    ]);

    expect(platform.createAgentSession).not.toHaveBeenCalled();
    expect(deps.saveReviewReport).toHaveBeenCalledTimes(3);
    expect(deps.saveReviewReport).toHaveBeenNthCalledWith(
      1,
      platform.paths,
      root,
      expect.objectContaining({
        gates: expect.arrayContaining([
          expect.objectContaining({ gate: "test-suite", status: "skipped", summary: expect.stringContaining("no configured run matches this target") }),
        ]),
      }),
    );
    expect(deps.saveReviewReport).toHaveBeenNthCalledWith(
      2,
      platform.paths,
      alpha,
      expect.objectContaining({
        gates: expect.arrayContaining([
          expect.objectContaining({ gate: "lint", status: "passed" }),
          expect.objectContaining({ gate: "test-suite", status: "passed" }),
        ]),
      }),
    );
    expect(deps.saveReviewReport).toHaveBeenNthCalledWith(
      3,
      platform.paths,
      beta,
      expect.objectContaining({
        gates: expect.arrayContaining([
          expect.objectContaining({ gate: "test-suite", status: "skipped", summary: expect.stringContaining("no configured run matches this target") }),
        ]),
      }),
    );

    expect(deps.notifyInfo).toHaveBeenCalledWith(
      ctx,
      "Checks complete: 3 passed",
      expect.stringContaining("root-app (root): passed — 1 passed, 0 failed, 0 blocked, 1 skipped"),
    );
    const summaryDetail = (deps.notifyInfo as ReturnType<typeof mock>).mock.calls.at(-1)?.[2] as string;
    expect(summaryDetail).toContain("alpha (packages/alpha): passed — 2 passed, 0 failed, 0 blocked, 0 skipped");
    expect(summaryDetail).toContain("beta (packages/beta): passed — 1 passed, 0 failed, 0 blocked, 1 skipped");
  },
});
