import { describe, expect, test } from "bun:test";
import { checkSchema } from "../../helpers/schema.js"
import type { ExecResult } from "../../../src/platform/types.js";
import type { GateExecutionContext, ProjectFacts, WorkspaceTarget } from "../../../src/types.js";
import { testSuiteGate } from "../../../src/quality/gates/test-suite.js";

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

function createProjectFacts(testScript?: string): ProjectFacts {
  return {
    cwd: "/repo",
    packageScripts: testScript ? { test: testScript } : {},
    lockfiles: [],
    activeTools: [],
    existingGates: {},
    targets: [
      {
        name: "repo",
        kind: "root",
        relativeDir: ".",
        packageScripts: testScript ? { test: testScript } : {},
      },
    ],
  };
}

function createContext(execShell: GateExecutionContext["execShell"]): GateExecutionContext {
  return {
    cwd: "/repo",
    changedFiles: [],
    scopeFiles: [],
    fileScope: "all-files",
    target: ROOT_TARGET,
    exec: async () => ({ stdout: "", stderr: "", code: 0 }),
    execShell,
    getLspDiagnostics: async () => [],
    createAgentSession: async () => {
      throw new Error("not implemented");
    },
    activeTools: [],
  };
}

describe("testSuiteGate", () => {
  test("configSchema matches enabled and disabled test-suite configs", () => {
    expect(
      checkSchema(testSuiteGate.configSchema, {
        enabled: true,
        runs: [{ command: "bun test tests/", target: { scope: "all-targets" } }],
      }),
    ).toBe(true);
    expect(checkSchema(testSuiteGate.configSchema, { enabled: false })).toBe(true);
    expect(checkSchema(testSuiteGate.configSchema, { enabled: true, runs: [] })).toBe(false);
    expect(checkSchema(testSuiteGate.configSchema, { enabled: false, extra: true })).toBe(false);
  });

  test("detect recommends the package test script when present", () => {
    expect(testSuiteGate.detect(createProjectFacts("bun test tests/"))).toEqual({
      suggestedConfig: {
        enabled: true,
        runs: [{ command: "bun test tests/", target: { scope: "all-targets" } }],
      },
      confidence: "high",
      reason: "Detected package.json test script.",
    });
  });

  test("detect returns null when no test script exists", () => {
    expect(testSuiteGate.detect(createProjectFacts())).toBeNull();
  });

  test("run passes when the test command exits successfully", async () => {
    let receivedCommand: string | undefined;
    let receivedOptions: { cwd?: string; timeout?: number } | undefined;
    const context = createContext(async (command, options): Promise<ExecResult> => {
      receivedCommand = command;
      receivedOptions = options;
      return { stdout: "all good", stderr: "", code: 0 };
    });

    const result = await testSuiteGate.run(context, {
      enabled: true,
      runs: [{ command: "bun test tests/quality/gates/test-suite.test.ts", target: { scope: "all-targets" } }],
    });

    expect(receivedCommand).toBe("bun test tests/quality/gates/test-suite.test.ts");
    expect(receivedOptions).toEqual({ cwd: "/repo", timeout: 120000 });
    expect(result).toEqual({
      gate: "test-suite",
      status: "passed",
      summary: "Test suite passed.",
      issues: [],
      metadata: {
        target: ".",
        runs: [
          {
            command: "bun test tests/quality/gates/test-suite.test.ts",
            target: { scope: "all-targets" },
            exitCode: 0,
          },
        ],
      },
    });
  });

  test("run fails with stderr when the test command exits non-zero", async () => {
    const context = createContext(async (): Promise<ExecResult> => ({
      stdout: "stdout output",
      stderr: "stderr output",
      code: 1,
    }));

    const result = await testSuiteGate.run(context, {
      enabled: true,
      runs: [{ command: "bun test", target: { scope: "all-targets" } }],
    });

    expect(result).toEqual({
      gate: "test-suite",
      status: "failed",
      summary: "Test suite failed for root.",
      issues: [
        {
          severity: "error",
          message: "Test suite command failed for root (all targets).",
          detail: "stderr output",
        },
      ],
      metadata: {
        target: ".",
        runs: [{ command: "bun test", target: { scope: "all-targets" }, exitCode: 1 }],
        failedCommand: "bun test",
      },
    });
  });

  test("run falls back to stdout or a generic error message when stderr is empty", async () => {
    const stdoutFailure = createContext(async (): Promise<ExecResult> => ({
      stdout: "stdout fallback",
      stderr: "",
      code: 1,
    }));

    const stdoutResult = await testSuiteGate.run(stdoutFailure, {
      enabled: true,
      runs: [{ command: "bun test", target: { scope: "all-targets" } }],
    });
    expect(stdoutResult.issues).toEqual([
      {
        severity: "error",
        message: "Test suite command failed for root (all targets).",
        detail: "stdout fallback",
      },
    ]);

    const genericFailure = createContext(async (): Promise<ExecResult> => ({
      stdout: "",
      stderr: "",
      code: 1,
    }));

    const genericResult = await testSuiteGate.run(genericFailure, {
      enabled: true,
      runs: [{ command: "bun test", target: { scope: "all-targets" } }],
    });
    expect(genericResult.issues).toEqual([
      {
        severity: "error",
        message: "Test suite command failed for root (all targets).",
        detail: "Test suite command exited with code 1.",
      },
    ]);
  });
});
