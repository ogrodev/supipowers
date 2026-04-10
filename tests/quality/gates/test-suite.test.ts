import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import type { ExecResult } from "../../../src/platform/types.js";
import type { GateExecutionContext, ProjectFacts } from "../../../src/types.js";
import { testSuiteGate } from "../../../src/quality/gates/test-suite.js";

function createProjectFacts(testScript?: string): ProjectFacts {
  return {
    cwd: "/repo",
    packageScripts: testScript ? { test: testScript } : {},
    lockfiles: [],
    activeTools: [],
    existingGates: {},
  };
}

function createContext(execShell: GateExecutionContext["execShell"]): GateExecutionContext {
  return {
    cwd: "/repo",
    changedFiles: [],
    scopeFiles: [],
    fileScope: "all-files",
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
    expect(Value.Check(testSuiteGate.configSchema, { enabled: true, command: "bun test tests/" })).toBe(true);
    expect(Value.Check(testSuiteGate.configSchema, { enabled: false, command: null })).toBe(true);
    expect(Value.Check(testSuiteGate.configSchema, { enabled: true, command: "" })).toBe(false);
    expect(Value.Check(testSuiteGate.configSchema, { enabled: false, extra: true })).toBe(false);
  });

  test("detect recommends the package test script when present", () => {
    expect(testSuiteGate.detect(createProjectFacts("bun test tests/"))).toEqual({
      suggestedConfig: { enabled: true, command: "bun test tests/" },
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

    const result = await testSuiteGate.run(context, { enabled: true, command: "bun test tests/quality/gates/test-suite.test.ts" });

    expect(receivedCommand).toBe("bun test tests/quality/gates/test-suite.test.ts");
    expect(receivedOptions).toEqual({ cwd: "/repo", timeout: 120000 });
    expect(result).toEqual({
      gate: "test-suite",
      status: "passed",
      summary: "Test suite passed.",
      issues: [],
      metadata: {
        command: "bun test tests/quality/gates/test-suite.test.ts",
        exitCode: 0,
      },
    });
  });

  test("run fails with stderr when the test command exits non-zero", async () => {
    const context = createContext(async (): Promise<ExecResult> => ({
      stdout: "stdout output",
      stderr: "stderr output",
      code: 1,
    }));

    const result = await testSuiteGate.run(context, { enabled: true, command: "bun test" });

    expect(result).toEqual({
      gate: "test-suite",
      status: "failed",
      summary: "Test suite failed.",
      issues: [
        {
          severity: "error",
          message: "Test suite command failed.",
          detail: "stderr output",
        },
      ],
      metadata: {
        command: "bun test",
        exitCode: 1,
      },
    });
  });

  test("run falls back to stdout or a generic error message when stderr is empty", async () => {
    const stdoutFailure = createContext(async (): Promise<ExecResult> => ({
      stdout: "stdout fallback",
      stderr: "",
      code: 1,
    }));

    const stdoutResult = await testSuiteGate.run(stdoutFailure, { enabled: true, command: "bun test" });
    expect(stdoutResult.issues).toEqual([
      {
        severity: "error",
        message: "Test suite command failed.",
        detail: "stdout fallback",
      },
    ]);

    const genericFailure = createContext(async (): Promise<ExecResult> => ({
      stdout: "",
      stderr: "",
      code: 1,
    }));

    const genericResult = await testSuiteGate.run(genericFailure, { enabled: true, command: "bun test" });
    expect(genericResult.issues).toEqual([
      {
        severity: "error",
        message: "Test suite command failed.",
        detail: "Test suite command exited with code 1.",
      },
    ]);
  });
});
