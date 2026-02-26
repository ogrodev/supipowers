import { describe, expect, test } from "vitest";
import { recoverInterruptedExecutionState } from "../../src/execution/recovery";
import type { WorkflowState } from "../../src/types";

function baseState(phase: WorkflowState["phase"]): WorkflowState {
  return {
    phase,
    nextAction: "next",
    updatedAt: Date.now(),
    checkpoints: {
      hasDesignApproval: true,
      hasPlanArtifact: true,
      hasReviewPass: false,
    },
  };
}

describe("recovery", () => {
  test("does nothing for non-executing states", () => {
    const state = baseState("plan_ready");
    const result = recoverInterruptedExecutionState("/tmp/non-existing-cwd", state);

    expect(result.recovered).toBe(false);
    expect(result.state.phase).toBe("plan_ready");
  });

  test("recovers stale executing state", () => {
    const state = baseState("executing");
    const result = recoverInterruptedExecutionState("/tmp/non-existing-cwd", state);

    expect(result.recovered).toBe(true);
    expect(result.state.phase).toBe("blocked");
    expect(result.state.blocker).toContain("interrupted");
  });
});
