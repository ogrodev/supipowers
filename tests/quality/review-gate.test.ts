import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { evaluateReviewGate } from "../../src/quality/review-gate";
import type { WorkflowState } from "../../src/types";

function baseState(): WorkflowState {
  return {
    phase: "review_pending",
    nextAction: "review",
    updatedAt: Date.now(),
    checkpoints: {
      hasDesignApproval: true,
      hasPlanArtifact: true,
      hasReviewPass: false,
    },
  };
}

function workspaceWithSummary(withSummary: boolean): string {
  const cwd = mkdtempSync(join(tmpdir(), "supipowers-review-"));
  if (withSummary) {
    const runDir = join(cwd, ".pi", "supipowers", "runs", "run-1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "summary.md"), "# summary\n", "utf-8");
  }
  return cwd;
}

describe("review gate", () => {
  test("passes when run summary exists and review pass not required", () => {
    const cwd = workspaceWithSummary(true);
    const result = evaluateReviewGate(cwd, baseState(), "balanced", { requireReviewPass: false });

    expect(result.passed).toBe(true);
    expect(result.blocking).toBe(false);
  });

  test("blocks when review pass is required but missing", () => {
    const cwd = workspaceWithSummary(true);
    const result = evaluateReviewGate(cwd, baseState(), "strict", { requireReviewPass: true });

    expect(result.passed).toBe(false);
    expect(result.blocking).toBe(true);
  });

  test("warns in advisory mode without summary", () => {
    const cwd = workspaceWithSummary(false);
    const result = evaluateReviewGate(cwd, baseState(), "advisory", { requireReviewPass: false });

    expect(result.passed).toBe(false);
    expect(result.blocking).toBe(false);
  });
});
