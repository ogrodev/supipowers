import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { autoAdvanceToPlanReady } from "../../src/commands/auto-plan";
import type { WorkflowState } from "../../src/types";

function createWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "supipowers-auto-plan-"));
}

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

describe("autoAdvanceToPlanReady", () => {
  test("auto-advances from idle to plan_ready and creates plan", () => {
    const cwd = createWorkspace();
    const state = baseState("idle");

    const result = autoAdvanceToPlanReady(cwd, state, "balanced", "Implement search with tests");

    expect(result.ok).toBe(true);
    expect(result.state.phase).toBe("plan_ready");
    expect(result.state.checkpoints.hasDesignApproval).toBe(true);
    expect(result.state.checkpoints.hasPlanArtifact).toBe(true);
    expect(result.state.planArtifactPath).toBeTruthy();
    expect(existsSync(result.state.planArtifactPath ?? "")).toBe(true);

    const types = result.events.map((event) => event.type);
    expect(types).toContain("workflow_started");
    expect(types).toContain("design_approved");
    expect(types).toContain("plan_ready");
  });

  test("returns ready state without changing when already plan_ready", () => {
    const cwd = createWorkspace();
    const state: WorkflowState = {
      ...baseState("plan_ready"),
      objective: "Existing objective",
      planArtifactPath: join(cwd, ".pi", "supipowers", "artifacts", "plan.md"),
      checkpoints: {
        hasDesignApproval: true,
        hasPlanArtifact: true,
        hasReviewPass: false,
      },
    };

    const result = autoAdvanceToPlanReady(cwd, state, "balanced");

    expect(result.ok).toBe(true);
    expect(result.state.phase).toBe("plan_ready");
    expect(result.events.length).toBe(0);
  });

  test("fails while execution is in progress", () => {
    const cwd = createWorkspace();
    const state: WorkflowState = {
      ...baseState("executing"),
      objective: "Do work",
    };

    const result = autoAdvanceToPlanReady(cwd, state, "balanced");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("already in 'executing'");
  });

  test("fails when objective is missing", () => {
    const cwd = createWorkspace();
    const state = baseState("idle");

    const result = autoAdvanceToPlanReady(cwd, state, "balanced");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Objective is required");
  });
});
