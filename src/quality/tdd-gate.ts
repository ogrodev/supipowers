import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { shouldBlockOnMissingGate } from "../engine/policies";
import { readExecutionEvents } from "../storage/execution-history";
import type { Strictness, WorkflowState } from "../types";
import type { QualityGateResult, QualityIssue } from "./types";

export interface TddGateOptions {
  requireExecutionEvidence?: boolean;
}

function hasTestFiles(cwd: string): boolean {
  const commonDirs = ["tests", "__tests__"];
  if (commonDirs.some((dir) => existsSync(join(cwd, dir)))) return true;

  const roots = ["src", "app", "lib"];
  for (const root of roots) {
    const rootPath = join(cwd, root);
    if (!existsSync(rootPath)) continue;

    const stack = [rootPath];
    while (stack.length > 0) {
      const dir = stack.pop();
      if (!dir) continue;
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (/\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry)) {
          return true;
        }
      }
    }
  }

  return false;
}

export function evaluateTddGate(
  cwd: string,
  state: WorkflowState,
  strictness: Strictness,
  options: TddGateOptions = {},
): QualityGateResult {
  const issues: QualityIssue[] = [];

  if (!state.checkpoints.hasPlanArtifact || !state.planArtifactPath) {
    const blocking = shouldBlockOnMissingGate(strictness, "major");
    issues.push({
      gate: "tdd",
      importance: "major",
      blocking,
      message: "No plan artifact evidence found for TDD flow.",
      recommendation: "Run /sp-start (auto-plan) or /sp-execute to prepare plan evidence before implementation.",
    });
  }

  if (!hasTestFiles(cwd)) {
    const blocking = shouldBlockOnMissingGate(strictness, "major");
    issues.push({
      gate: "tdd",
      importance: "major",
      blocking,
      message: "No test files were found in the workspace.",
      recommendation: "Create or update tests before shipping changes.",
    });
  }

  if (options.requireExecutionEvidence) {
    const events = readExecutionEvents(cwd);
    const completed = events.some((event) => event.type === "execution_completed");
    if (!completed) {
      const blocking = shouldBlockOnMissingGate(strictness, "major");
      issues.push({
        gate: "tdd",
        importance: "major",
        blocking,
        message: "No completed execution evidence found.",
        recommendation: "Run /sp-execute and validate outputs before finishing.",
      });
    }
  }

  return {
    gate: "tdd",
    passed: issues.length === 0,
    blocking: issues.some((issue) => issue.blocking),
    issues,
  };
}
