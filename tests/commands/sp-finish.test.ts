import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { finishWorkflow, parseFinishArgs } from "../../src/execution/finish-workflow";
import type { WorkflowState } from "../../src/types";

function workspaceWithRun(): { cwd: string; planPath: string } {
  const cwd = mkdtempSync(join(tmpdir(), "supipowers-finish-"));
  const runDir = join(cwd, ".pi", "supipowers", "runs", "run-1");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "summary.md"), "# run summary\n", "utf-8");
  writeFileSync(
    join(runDir, "details.json"),
    JSON.stringify({ adapter: "native", status: "completed" }, null, 2),
    "utf-8",
  );

  const testsDir = join(cwd, "tests");
  mkdirSync(testsDir, { recursive: true });
  writeFileSync(join(testsDir, "workflow.test.ts"), "test('ok', () => {})\n", "utf-8");

  const planPath = join(cwd, ".pi", "supipowers", "artifacts", "plan.md");
  mkdirSync(join(cwd, ".pi", "supipowers", "artifacts"), { recursive: true });
  writeFileSync(planPath, "# plan\n", "utf-8");

  const eventsPath = join(cwd, ".pi", "supipowers", "events.jsonl");
  writeFileSync(
    eventsPath,
    `${JSON.stringify({ ts: Date.now(), type: "execution_completed", runId: "run-1", meta: { adapter: "native" } })}\n`,
    "utf-8",
  );

  return { cwd, planPath };
}

function reviewPendingState(planPath?: string): WorkflowState {
  return {
    phase: "review_pending",
    nextAction: "review",
    updatedAt: Date.now(),
    objective: "Ship M7",
    planArtifactPath: planPath,
    checkpoints: {
      hasDesignApproval: true,
      hasPlanArtifact: true,
      hasReviewPass: true,
    },
  };
}

describe("sp-finish workflow", () => {
  test("parses finish args", () => {
    expect(parseFinishArgs("merge --review-pass")).toEqual({ mode: "merge", markReviewPass: true });
    expect(parseFinishArgs("pr")).toEqual({ mode: "pr", markReviewPass: false });
    expect(parseFinishArgs("")).toEqual({ mode: "keep", markReviewPass: false });
  });

  test("completes workflow when gates pass", () => {
    const { cwd, planPath } = workspaceWithRun();
    const result = finishWorkflow({
      cwd,
      state: reviewPendingState(planPath),
      strictness: "strict",
      mode: "merge",
      markReviewPass: false,
    });

    expect(result.ok).toBe(true);
    expect(result.state.phase).toBe("completed");
    expect(result.reportPath).toBeDefined();
    expect(result.message).toContain("Workflow finished using mode 'merge'");
  });

  test("blocks finish when review pass is missing in strict mode", () => {
    const { cwd, planPath } = workspaceWithRun();
    const state = {
      ...reviewPendingState(planPath),
      checkpoints: {
        ...reviewPendingState(planPath).checkpoints,
        hasReviewPass: false,
      },
    };

    const result = finishWorkflow({
      cwd,
      state,
      strictness: "strict",
      mode: "keep",
      markReviewPass: false,
    });

    expect(result.ok).toBe(false);
    expect(result.state.phase).toBe("blocked");
    expect(result.message).toContain("Quality gates failed");
  });
});
