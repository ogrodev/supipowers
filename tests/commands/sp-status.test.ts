import { describe, expect, test } from "vitest";
import { buildStatusLine } from "../../src/ui/status";
import { buildWidgetLines } from "../../src/ui/widget";
import type { WorkflowState } from "../../src/types";

const state: WorkflowState = {
  phase: "plan_ready",
  nextAction: "Run /sp-execute",
  updatedAt: Date.now(),
  objective: "Build authentication flow",
  checkpoints: {
    hasDesignApproval: true,
    hasPlanArtifact: true,
    hasReviewPass: false,
  },
  planArtifactPath: ".pi/supipowers/artifacts/plan-1.md",
};

describe("status and widget ui", () => {
  test("builds deterministic status line", () => {
    const line = buildStatusLine(state, "balanced");
    expect(line).toContain("Supipowers phase: plan_ready");
    expect(line).toContain("strictness: balanced");
  });

  test("renders widget lines with objective and plan path", () => {
    const lines = buildWidgetLines(state, "balanced");
    expect(lines.some((line) => line.includes("Objective: Build authentication flow"))).toBe(true);
    expect(lines.some((line) => line.includes("Plan: .pi/supipowers/artifacts/plan-1.md"))).toBe(true);
  });
});
