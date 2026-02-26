import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildRewoundState, isRewindPhase, parseRewindArgs } from "../../src/commands/sp-rewind";
import type { WorkflowState } from "../../src/types";

function createWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "supipowers-rewind-"));
}

function baseState(phase: WorkflowState["phase"]): WorkflowState {
  return {
    phase,
    nextAction: "next",
    updatedAt: Date.now(),
    objective: "Implement profile page",
    planArtifactPath: "/tmp/non-existent-plan.md",
    checkpoints: {
      hasDesignApproval: true,
      hasPlanArtifact: true,
      hasReviewPass: true,
    },
  };
}

describe("sp-rewind", () => {
  test("parses args with --to and --yes", () => {
    expect(parseRewindArgs("--to planning --yes")).toEqual({ to: "planning", yes: true });
    expect(parseRewindArgs("plan_ready")).toEqual({ to: "plan_ready", yes: false });
    expect(parseRewindArgs("--to=brainstorming")).toEqual({ to: "brainstorming", yes: false });
  });

  test("validates rewind phases", () => {
    expect(isRewindPhase("idle")).toBe(true);
    expect(isRewindPhase("planning")).toBe(true);
    expect(isRewindPhase("executing")).toBe(false);
  });

  test("rewind to planning clears plan artifact and review pass", () => {
    const cwd = createWorkspace();
    const state = baseState("review_pending");

    const result = buildRewoundState(cwd, state, "planning");

    expect(result.state.phase).toBe("planning");
    expect(result.state.planArtifactPath).toBeUndefined();
    expect(result.state.checkpoints.hasPlanArtifact).toBe(false);
    expect(result.state.checkpoints.hasReviewPass).toBe(false);
  });

  test("rewind to plan_ready regenerates plan when missing", () => {
    const cwd = createWorkspace();
    const state = baseState("blocked");
    state.planArtifactPath = undefined;
    state.checkpoints.hasPlanArtifact = false;

    const result = buildRewoundState(cwd, state, "plan_ready");

    expect(result.state.phase).toBe("plan_ready");
    expect(result.state.planArtifactPath).toBeTruthy();
    expect(existsSync(result.state.planArtifactPath ?? "")).toBe(true);
    expect(result.state.checkpoints.hasPlanArtifact).toBe(true);
    expect(result.generatedPlanPath).toBe(result.state.planArtifactPath);
  });
});
