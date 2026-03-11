import type { GateResult } from "../types.js";

export function buildTestGatePrompt(
  testCommand: string | null,
  changedOnly: boolean,
  changedFiles?: string[]
): string {
  const cmd = testCommand ?? "npm test";
  const scope = changedOnly && changedFiles
    ? `Only run tests related to: ${changedFiles.join(", ")}`
    : "Run the full test suite.";

  return [
    scope,
    "",
    `Command: ${cmd}`,
    "",
    "Report the results:",
    "- Total tests, passed, failed, skipped",
    "- For each failure: test name, file, error message",
  ].join("\n");
}

export function createTestGateResult(
  passed: boolean,
  totalTests: number,
  failedTests: number,
  failures: { message: string; file?: string }[]
): GateResult {
  return {
    gate: "test-suite",
    passed,
    issues: failures.map((f) => ({
      severity: "error" as const,
      message: `Test failed: ${f.message}`,
      file: f.file,
    })),
  };
}
