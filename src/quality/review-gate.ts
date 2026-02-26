import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { shouldBlockOnMissingGate } from "../engine/policies";
import type { Strictness, WorkflowState } from "../types";
import type { QualityGateResult, QualityIssue } from "./types";

export interface ReviewGateOptions {
  requireReviewPass?: boolean;
  requireRunSummary?: boolean;
}

function hasRunSummary(cwd: string): boolean {
  const runsDir = join(cwd, ".pi", "supipowers", "runs");
  if (!existsSync(runsDir)) return false;

  const runDirs = readdirSync(runsDir);
  return runDirs.some((runId) => existsSync(join(runsDir, runId, "summary.md")));
}

export function evaluateReviewGate(
  cwd: string,
  state: WorkflowState,
  strictness: Strictness,
  options: ReviewGateOptions = {},
): QualityGateResult {
  const issues: QualityIssue[] = [];

  const requireRunSummary = options.requireRunSummary !== false;
  if (requireRunSummary && !hasRunSummary(cwd)) {
    const blocking = shouldBlockOnMissingGate(strictness, "major");
    issues.push({
      gate: "review",
      importance: "major",
      blocking,
      message: "No run summary artifact found for review.",
      recommendation: "Execute a run and review the generated summary before closing work.",
    });
  }

  if (options.requireReviewPass && !state.checkpoints.hasReviewPass) {
    const blocking = shouldBlockOnMissingGate(strictness, "major");
    issues.push({
      gate: "review",
      importance: "major",
      blocking,
      message: "Review pass checkpoint has not been marked complete.",
      recommendation: "Complete review and set review pass before finishing.",
    });
  }

  return {
    gate: "review",
    passed: issues.length === 0,
    blocking: issues.some((issue) => issue.blocking),
    issues,
  };
}
