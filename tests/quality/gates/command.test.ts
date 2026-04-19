import { describe, expect, test } from "bun:test";
import type { ExecResult } from "../../../src/platform/types.js";
import type { CommandGateConfig, GateExecutionContext, ProjectFacts, WorkspaceTarget } from "../../../src/types.js";
import { createCommandGate } from "../../../src/quality/gates/command.js";

const commandGate = createCommandGate({
  id: "test-suite",
  label: "Test suite",
  description: "Runs tests.",
  scriptNames: ["test"],
});

const ROOT_TARGET: WorkspaceTarget = {
  id: "repo",
  name: "repo",
  kind: "root",
  repoRoot: "/repo",
  packageDir: "/repo",
  manifestPath: "/repo/package.json",
  relativeDir: ".",
  version: "1.0.0",
  private: true,
  packageManager: "bun",
};

const ALPHA_TARGET: WorkspaceTarget = {
  ...ROOT_TARGET,
  id: "alpha",
  name: "alpha",
  kind: "workspace",
  packageDir: "/repo/packages/alpha",
  manifestPath: "/repo/packages/alpha/package.json",
  relativeDir: "packages/alpha",
};

const BETA_TARGET: WorkspaceTarget = {
  ...ROOT_TARGET,
  id: "beta",
  name: "beta",
  kind: "workspace",
  packageDir: "/repo/packages/beta",
  manifestPath: "/repo/packages/beta/package.json",
  relativeDir: "packages/beta",
};

function createProjectFacts(targets: ProjectFacts["targets"]): ProjectFacts {
  return {
    cwd: "/repo",
    packageScripts: {},
    lockfiles: [],
    activeTools: [],
    existingGates: {},
    targets,
  };
}

function createContext(
  target: WorkspaceTarget,
  execShell: GateExecutionContext["execShell"],
): GateExecutionContext {
  return {
    cwd: target.packageDir,
    changedFiles: [],
    scopeFiles: [],
    fileScope: "all-files",
    target,
    exec: async () => ({ stdout: "", stderr: "", code: 0 }),
    execShell,
    getLspDiagnostics: async () => [],
    createAgentSession: async () => {
      throw new Error("not implemented");
    },
    activeTools: [],
  };
}

describe("createCommandGate", () => {
  test("detects a shared command across all targets", () => {
    const result = commandGate.detect(
      createProjectFacts([
        { name: "repo", kind: "root", relativeDir: ".", packageScripts: { test: "bun test" } },
        { name: "alpha", kind: "workspace", relativeDir: "packages/alpha", packageScripts: { test: "bun test" } },
        { name: "beta", kind: "workspace", relativeDir: "packages/beta", packageScripts: { test: "bun test" } },
      ]),
    );

    expect(result).toEqual({
      suggestedConfig: {
        enabled: true,
        runs: [{ command: "bun test", target: { scope: "all-targets" } }],
      },
      confidence: "high",
      reason: "Detected test suite command shared across all targets via per-target scripts.",
    });
  });

  test("detects separate root and shared workspace commands", () => {
    const result = commandGate.detect(
      createProjectFacts([
        { name: "repo", kind: "root", relativeDir: ".", packageScripts: { test: "bun test:root" } },
        { name: "alpha", kind: "workspace", relativeDir: "packages/alpha", packageScripts: { test: "bun test:ws" } },
        { name: "beta", kind: "workspace", relativeDir: "packages/beta", packageScripts: { test: "bun test:ws" } },
      ]),
    );

    expect(result).toEqual({
      suggestedConfig: {
        enabled: true,
        runs: [
          { command: "bun test:root", target: { scope: "root" } },
          { command: "bun test:ws", target: { scope: "all-workspaces" } },
        ],
      },
      confidence: "high",
      reason: "Detected test suite commands covering the root target and all workspace targets via per-target scripts.",
    });
  });

  test("detects workspace-specific commands when every target is covered", () => {
    const result = commandGate.detect(
      createProjectFacts([
        { name: "repo", kind: "root", relativeDir: ".", packageScripts: { test: "bun test:root" } },
        { name: "alpha", kind: "workspace", relativeDir: "packages/alpha", packageScripts: { test: "bun test:alpha" } },
        { name: "beta", kind: "workspace", relativeDir: "packages/beta", packageScripts: { test: "bun test:beta" } },
      ]),
    );

    expect(result).toEqual({
      suggestedConfig: {
        enabled: true,
        runs: [
          { command: "bun test:root", target: { scope: "root" } },
          { command: "bun test:alpha", target: { scope: "workspace", relativeDir: "packages/alpha" } },
          { command: "bun test:beta", target: { scope: "workspace", relativeDir: "packages/beta" } },
        ],
      },
      confidence: "high",
      reason: "Detected test suite commands covering every target via per-target scripts.",
    });
  });

  test("returns a note instead of auto-configuring incomplete target coverage", () => {
    const result = commandGate.detect(
      createProjectFacts([
        { name: "repo", kind: "root", relativeDir: ".", packageScripts: {} },
        { name: "alpha", kind: "workspace", relativeDir: "packages/alpha", packageScripts: { test: "bun test" } },
        { name: "beta", kind: "workspace", relativeDir: "packages/beta", packageScripts: { test: "bun test" } },
      ]),
    );

    expect(result).toEqual({
      suggestedConfig: null,
      confidence: "medium",
      reason:
        "Detected test suite commands in workspace targets only (packages/alpha, packages/beta), not in the root target. /supi:checks All also runs the root target, so this gate was not auto-configured.",
    });
  });

  test("runs only the commands that match the current target", async () => {
    const calls: Array<{ command: string; options: { cwd?: string; timeout?: number } | undefined }> = [];
    const context = createContext(ALPHA_TARGET, async (command, options): Promise<ExecResult> => {
      calls.push({ command, options });
      return { stdout: "ok", stderr: "", code: 0 };
    });
    const config: CommandGateConfig = {
      enabled: true,
      runs: [
        { command: "bun test:root", target: { scope: "root" } },
        { command: "bun test:workspace", target: { scope: "all-workspaces" } },
        { command: "bun test:alpha", target: { scope: "workspace", relativeDir: "packages/alpha" } },
      ],
    };

    const result = await commandGate.run(context, config);

    expect(calls).toEqual([
      { command: "bun test:workspace", options: { cwd: "/repo/packages/alpha", timeout: 120000 } },
      { command: "bun test:alpha", options: { cwd: "/repo/packages/alpha", timeout: 120000 } },
    ]);
    expect(result.status).toBe("passed");
    expect(result.metadata).toEqual({
      target: "packages/alpha",
      runs: [
        { command: "bun test:workspace", target: { scope: "all-workspaces" }, exitCode: 0 },
        { command: "bun test:alpha", target: { scope: "workspace", relativeDir: "packages/alpha" }, exitCode: 0 },
      ],
    });
  });

  test("marks targets without matching runs as skipped", async () => {
    const context = createContext(BETA_TARGET, async (): Promise<ExecResult> => {
      throw new Error("should not run");
    });
    const config: CommandGateConfig = {
      enabled: true,
      runs: [{ command: "bun test:root", target: { scope: "root" } }],
    };

    const result = await commandGate.run(context, config);

    expect(result).toEqual({
      gate: "test-suite",
      status: "skipped",
      summary: "Test suite skipped for packages/beta — no configured run matches this target.",
      issues: [],
      metadata: {
        target: "packages/beta",
        reason: "no-matching-runs",
      },
    });
  });
});
