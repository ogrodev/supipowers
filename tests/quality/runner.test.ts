import { describe, expect, mock, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { runQualityGates } from "../../src/quality/runner.js";
import { lspDiagnosticsGate } from "../../src/quality/gates/lsp-diagnostics.js";
import type { AgentSession, ExecOptions, ExecResult, Platform } from "../../src/platform/types.js";
import type {
  GateDefinition,
  GateExecutionContext,
  GateId,
  GateResult,
  ResolvedModel,
  WorkspaceTarget,
} from "../../src/types.js";

const defaultReviewModel: ResolvedModel = {
  model: "claude-opus-4-6",
  thinkingLevel: "high",
  source: "action",
};

function createAgentSession(): AgentSession {
  return {
    subscribe: () => () => {},
    prompt: async () => {},
    state: { messages: [] },
    dispose: async () => {},
  };
}

function createAgentSessionWithText(finalText: string): AgentSession {
  return {
    subscribe: () => () => {},
    prompt: async () => {},
    state: { messages: [{ role: "assistant", content: finalText }] },
    dispose: async () => {},
  };
}

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

function createWorkspaceTargets(repoRoot = "/repo") {
  return {
    root: createTarget({ repoRoot, id: "root-app", name: "root-app", relativeDir: ".", kind: "root" }),
    alpha: createTarget({
      repoRoot,
      id: "@repo/alpha",
      name: "@repo/alpha",
      relativeDir: "packages/alpha",
      packageDir: `${repoRoot}/packages/alpha`,
      kind: "workspace",
    }),
    beta: createTarget({
      repoRoot,
      id: "@repo/beta",
      name: "@repo/beta",
      relativeDir: "packages/beta",
      packageDir: `${repoRoot}/packages/beta`,
      kind: "workspace",
    }),
  };
}

function createPlatformWithLspSession(options?: {
  changedFiles?: string[];
  trackedFiles?: string[];
  activeTools?: string[];
  finalAssistantText?: string;
}): Pick<Platform, "exec" | "getActiveTools" | "createAgentSession"> {
  return {
    ...createPlatform({
      changedFiles: options?.changedFiles ?? ["src/review.ts"],
      trackedFiles: options?.trackedFiles,
    }),
    getActiveTools: () => options?.activeTools ?? ["lsp"],
    createAgentSession: async () =>
      createAgentSessionWithText(
        options?.finalAssistantText ??
          JSON.stringify([
            {
              file: "src/review.ts",
              diagnostics: [
                { severity: "warning", message: "Unused value", line: 4, column: 2 },
              ],
            },
          ]),
      ),
  };
}

function createPlatform(options?: {
  changedFiles?: string[];
  trackedFiles?: string[];
  onExec?: (cmd: string, args: string[], opts?: ExecOptions) => void;
}): Pick<Platform, "exec" | "getActiveTools" | "createAgentSession"> {
  const changedFiles = options?.changedFiles ?? ["src/review.ts"];
  const trackedFiles = options?.trackedFiles ?? changedFiles;

  return {
    exec: async (cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult> => {
      options?.onExec?.(cmd, args, opts);
      if (cmd === "git") {
        const signature = args.join(" ");
        if (signature === "diff --name-only HEAD") {
          return { stdout: `${changedFiles.join("\n")}\n`, stderr: "", code: 0 };
        }
        if (signature === "diff --name-only --cached") {
          return { stdout: "", stderr: "", code: 0 };
        }
        if (signature === "ls-files --others --exclude-standard") {
          return { stdout: "", stderr: "", code: 0 };
        }
        if (signature === "ls-files") {
          return { stdout: `${trackedFiles.join("\n")}\n`, stderr: "", code: 0 };
        }
      }

      if (cmd === "sh" || cmd === "cmd") {
        return { stdout: "", stderr: "", code: 0 };
      }

      throw new Error(`Unexpected exec call: ${cmd} ${args.join(" ")}`);
    },
    getActiveTools: () => [],
    createAgentSession: async () => createAgentSession(),
  };
}

function createGate(gate: GateId, status: GateResult["status"] = "passed"): GateDefinition<any> {
  return {
    id: gate,
    description: `Gate ${gate}`,
    configSchema: Type.Any(),
    detect: () => null,
    run: async () => ({
      gate,
      status,
      summary: `${gate}: ${status}`,
      issues: [],
    }),
  };
}

describe("runQualityGates", () => {
  test("applies canonical gate order and aggregates report", async () => {
    const targets = createWorkspaceTargets();

    const report = await runQualityGates({
      platform: createPlatform(),
      cwd: "/tmp/project",
      target: targets.root,
      workspaceTargets: [targets.root],
      gates: {
        lint: { enabled: true, command: "eslint ." },
        "lsp-diagnostics": { enabled: true },
      },
      filters: {},
      reviewModel: defaultReviewModel,
      gateRegistry: {
        "lsp-diagnostics": createGate("lsp-diagnostics"),
        lint: createGate("lint"),
      },
      now: () => new Date("2026-04-10T00:00:00.000Z"),
    });

    expect(report.selectedGates).toEqual(["lsp-diagnostics", "lint"]);
    expect(report.summary).toEqual({ passed: 2, failed: 0, skipped: 0, blocked: 0 });
    expect(report.overallStatus).toBe("passed");
  });

  test("records skipped gates and omits disabled gates", async () => {
    const targets = createWorkspaceTargets();

    const report = await runQualityGates({
      platform: createPlatform(),
      cwd: "/tmp/project",
      target: targets.root,
      workspaceTargets: [targets.root],
      gates: {
        "lsp-diagnostics": { enabled: true },
        lint: { enabled: true, command: "eslint ." },
        "test-suite": { enabled: false, command: null },
      },
      filters: { skip: ["lint"] },
      reviewModel: { model: "claude-opus-4-6", thinkingLevel: null, source: "action" },
      gateRegistry: {
        "lsp-diagnostics": createGate("lsp-diagnostics"),
        lint: createGate("lint"),
        "test-suite": createGate("test-suite"),
      },
    });

    expect(report.gates.find((gate) => gate.gate === "lint")?.status).toBe("skipped");
    expect(report.gates.find((gate) => gate.gate === "test-suite")).toBeUndefined();
    expect(report.summary).toEqual({ passed: 1, failed: 0, skipped: 1, blocked: 0 });
  });

  test("emits progress events for scope discovery and gate lifecycle", async () => {
    const targets = createWorkspaceTargets();
    const onEvent = mock();

    const report = await runQualityGates({
      platform: createPlatform({ changedFiles: ["src/review.ts", "src/quality.ts"] }),
      cwd: "/tmp/project",
      target: targets.root,
      workspaceTargets: [targets.root],
      gates: {
        "lsp-diagnostics": { enabled: true },
        lint: { enabled: true, command: "eslint ." },
      },
      filters: { skip: ["lint"] },
      reviewModel: defaultReviewModel,
      gateRegistry: {
        "lsp-diagnostics": createGate("lsp-diagnostics"),
        lint: createGate("lint"),
      },
      onEvent,
    });

    expect(report.summary).toEqual({ passed: 1, failed: 0, skipped: 1, blocked: 0 });
    expect(onEvent.mock.calls).toEqual([
      [{ type: "scope-discovered", changedFiles: 2, scopeFiles: 2, fileScope: "changed-files" }],
      [{ type: "gate-started", gateId: "lsp-diagnostics" }],
      [{ type: "gate-skipped", gateId: "lint", reason: "Skipped by filter" }],
      [{
        type: "gate-completed",
        gateId: "lsp-diagnostics",
        status: "passed",
        summary: "lsp-diagnostics: passed",
      }],
    ]);
  });

  test("filters unrelated workspace changes out of changed-file scope", async () => {
    const targets = createWorkspaceTargets();
    const capturedContexts: GateExecutionContext[] = [];

    const report = await runQualityGates({
      platform: createPlatform({
        changedFiles: [
          "packages/alpha/src/kept.ts",
          "packages/beta/src/ignored.ts",
        ],
        trackedFiles: [
          "packages/alpha/src/kept.ts",
          "packages/beta/src/ignored.ts",
        ],
      }),
      cwd: targets.alpha.packageDir,
      target: targets.alpha,
      workspaceTargets: [targets.root, targets.alpha, targets.beta],
      gates: {
        lint: { enabled: true, command: "eslint ." },
      },
      filters: {},
      reviewModel: defaultReviewModel,
      gateRegistry: {
        lint: {
          id: "lint",
          description: "captures scope",
          configSchema: Type.Any(),
          detect: () => null,
          run: async (context) => {
            capturedContexts.push(context);
            return {
              gate: "lint",
              status: "passed",
              summary: "lint: passed",
              issues: [],
            };
          },
        },
      },
    });

    expect(report.summary).toEqual({ passed: 1, failed: 0, skipped: 0, blocked: 0 });
    expect(capturedContexts).toHaveLength(1);
    expect(capturedContexts[0]?.changedFiles).toEqual(["src/kept.ts"]);
    expect(capturedContexts[0]?.scopeFiles).toEqual(["src/kept.ts"]);
    expect(capturedContexts[0]?.fileScope).toBe("changed-files");
  });

  test("falls back to target-owned tracked files when only unrelated packages changed", async () => {
    const targets = createWorkspaceTargets();
    const onEvent = mock();

    await runQualityGates({
      platform: createPlatform({
        changedFiles: ["packages/beta/src/changed.ts"],
        trackedFiles: [
          "README.md",
          "packages/alpha/src/owned.ts",
          "packages/beta/src/changed.ts",
        ],
      }),
      cwd: targets.alpha.packageDir,
      target: targets.alpha,
      workspaceTargets: [targets.root, targets.alpha, targets.beta],
      gates: {
        lint: { enabled: true, command: "eslint ." },
      },
      filters: {},
      reviewModel: defaultReviewModel,
      gateRegistry: {
        lint: createGate("lint"),
      },
      onEvent,
    });

    expect(onEvent.mock.calls[0]?.[0]).toEqual({
      type: "scope-discovered",
      changedFiles: 0,
      scopeFiles: 1,
      fileScope: "all-files",
    });
  });

  test("runs gate commands in the selected package directory while git scope stays at repo root", async () => {
    const targets = createWorkspaceTargets();
    const execCalls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];

    const platform = createPlatform({
      changedFiles: ["packages/alpha/src/file.ts"],
      trackedFiles: ["packages/alpha/src/file.ts"],
      onExec: (cmd, args, opts) => {
        execCalls.push({ cmd, args, cwd: opts?.cwd });
      },
    });

    await runQualityGates({
      platform,
      cwd: targets.alpha.packageDir,
      target: targets.alpha,
      workspaceTargets: [targets.root, targets.alpha, targets.beta],
      gates: {
        lint: { enabled: true, command: "eslint ." },
      },
      filters: {},
      reviewModel: defaultReviewModel,
      gateRegistry: {
        lint: {
          id: "lint",
          description: "uses execShell",
          configSchema: Type.Any(),
          detect: () => null,
          run: async (context) => {
            await context.execShell("eslint .");
            return {
              gate: "lint",
              status: "passed",
              summary: "lint: passed",
              issues: [],
            };
          },
        },
      },
    });

    const gitCwds = execCalls
      .filter((call) => call.cmd === "git")
      .map((call) => call.cwd);
    const shellCommand = process.platform === "win32" ? "cmd" : "sh";
    const shellCalls = execCalls.filter((call) => call.cmd === shellCommand);

    expect(gitCwds).toEqual(["/repo", "/repo", "/repo"]);
    expect(shellCalls.map((call) => call.cwd)).toEqual(["/repo/packages/alpha"]);
    expect(shellCalls[0]?.args).toEqual(
      process.platform === "win32"
        ? ["/d", "/s", "/c", "eslint ."]
        : ["-lc", "eslint ."],
    );
  });

  test("uses the default LSP diagnostics integration when no override is provided", async () => {
    const targets = createWorkspaceTargets();

    const report = await runQualityGates({
      platform: createPlatformWithLspSession(),
      cwd: "/tmp/project",
      target: targets.root,
      workspaceTargets: [targets.root],
      gates: {
        "lsp-diagnostics": { enabled: true },
      },
      filters: {},
      reviewModel: defaultReviewModel,
      gateRegistry: {
        "lsp-diagnostics": lspDiagnosticsGate,
      },
    });

    expect(report.gates).toEqual([
      {
        gate: "lsp-diagnostics",
        status: "passed",
        summary: "LSP diagnostics passed with 1 warning(s) and no errors.",
        issues: [
          {
            severity: "warning",
            message: "Unused value",
            file: "src/review.ts",
            line: 4,
            detail: "column 2",
          },
        ],
      },
    ]);
    expect(report.summary).toEqual({ passed: 1, failed: 0, skipped: 0, blocked: 0 });
  });
});
