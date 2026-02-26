import { describe, expect, test } from "vitest";
import { transitionState } from "../../src/engine/state-machine";
import type { WorkflowState } from "../../src/types";

function baseState(phase: WorkflowState["phase"]): WorkflowState {
  return {
    phase,
    nextAction: "next",
    updatedAt: Date.now(),
    checkpoints: {
      hasDesignApproval: false,
      hasPlanArtifact: false,
      hasReviewPass: false,
    },
  };
}

describe("state machine", () => {
  test("allows valid transition", () => {
    const result = transitionState(baseState("idle"), {
      to: "brainstorming",
      strictness: "balanced",
    });

    expect(result.ok).toBe(true);
    expect(result.state.phase).toBe("brainstorming");
  });

  test("blocks invalid transition", () => {
    const result = transitionState(baseState("idle"), {
      to: "executing",
      strictness: "balanced",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Invalid transition");
    expect(result.state.blocker).toContain("Invalid transition");
  });

  test("moves to blocked when gate is missing in strict mode", () => {
    const result = transitionState(baseState("design_pending_approval"), {
      to: "design_approved",
      strictness: "strict",
      checkpoints: { hasDesignApproval: false },
    });

    expect(result.ok).toBe(false);
    expect(result.state.phase).toBe("blocked");
    expect(result.reason).toContain("Design approval");
  });
});
