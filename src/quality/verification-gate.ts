import type { Strictness, WorkflowState } from "../types";
import { evaluateReviewGate } from "./review-gate";
import { evaluateTddGate } from "./tdd-gate";
import type { QualityGateResult, RevalidationReport, RevalidationStage } from "./types";

export interface VerificationInput {
  cwd: string;
  state: WorkflowState;
  strictness: Strictness;
  stage?: RevalidationStage;
}

function stageConfig(stage: RevalidationStage): {
  requireExecutionEvidence: boolean;
  requireReviewPass: boolean;
  requireRunSummary: boolean;
} {
  if (stage === "pre_finish") {
    return { requireExecutionEvidence: true, requireReviewPass: true, requireRunSummary: true };
  }

  if (stage === "post_execute") {
    return { requireExecutionEvidence: true, requireReviewPass: false, requireRunSummary: true };
  }

  if (stage === "pre_execute") {
    return { requireExecutionEvidence: false, requireReviewPass: false, requireRunSummary: false };
  }

  return { requireExecutionEvidence: false, requireReviewPass: false, requireRunSummary: true };
}

export function evaluateVerificationGate(input: VerificationInput): RevalidationReport {
  const stage = input.stage ?? "manual";
  const cfg = stageConfig(stage);

  const tdd = evaluateTddGate(input.cwd, input.state, input.strictness, {
    requireExecutionEvidence: cfg.requireExecutionEvidence,
  });

  const review = evaluateReviewGate(input.cwd, input.state, input.strictness, {
    requireReviewPass: cfg.requireReviewPass,
    requireRunSummary: cfg.requireRunSummary,
  });

  const gates: QualityGateResult[] = [tdd, review];
  const issues = gates.flatMap((gate) => gate.issues);
  const nextActions = issues
    .map((issue) => issue.recommendation)
    .filter((value): value is string => Boolean(value));

  const blocking = gates.some((gate) => gate.blocking);
  const passed = issues.length === 0;
  const summary = passed
    ? `All quality gates passed for stage '${stage}'.`
    : blocking
      ? `Quality gates failed with blocking issues for stage '${stage}'.`
      : `Quality gates reported warnings for stage '${stage}'.`;

  return {
    strictness: input.strictness,
    stage,
    passed,
    blocking,
    gates,
    summary,
    nextActions,
  };
}

export function formatRevalidationReport(report: RevalidationReport): string {
  const lines: string[] = [];
  lines.push(`Supipowers revalidation (${report.stage})`);
  lines.push(`Strictness: ${report.strictness}`);
  lines.push(`Result: ${report.passed ? "PASS" : report.blocking ? "BLOCK" : "WARN"}`);

  for (const gate of report.gates) {
    lines.push(`- ${gate.gate}: ${gate.passed ? "pass" : gate.blocking ? "block" : "warn"}`);
    for (const issue of gate.issues) {
      lines.push(`  • ${issue.message}`);
      if (issue.recommendation) lines.push(`    ↳ ${issue.recommendation}`);
    }
  }

  if (report.nextActions.length > 0) {
    lines.push("Next actions:");
    report.nextActions.forEach((action, index) => lines.push(`${index + 1}. ${action}`));
  }

  return lines.join("\n");
}
