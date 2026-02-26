import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { evaluateTddGate } from "../../src/quality/tdd-gate";
import type { WorkflowState } from "../../src/types";

function baseState(): WorkflowState {
  return {
    phase: "plan_ready",
    nextAction: "execute",
    updatedAt: Date.now(),
    planArtifactPath: "plan.md",
    checkpoints: {
      hasDesignApproval: true,
      hasPlanArtifact: true,
      hasReviewPass: false,
    },
  };
}

function tempWorkspace(withTests: boolean): string {
  const cwd = mkdtempSync(join(tmpdir(), "supipowers-tdd-"));
  if (withTests) {
    const testsDir = join(cwd, "tests");
    mkdirSync(testsDir, { recursive: true });
    writeFileSync(join(testsDir, "sample.test.ts"), "test('ok', () => {})\n", "utf-8");
  }
  return cwd;
}

describe("tdd gate", () => {
  test("passes with plan and tests", () => {
    const cwd = tempWorkspace(true);
    const result = evaluateTddGate(cwd, baseState(), "balanced");

    expect(result.passed).toBe(true);
    expect(result.blocking).toBe(false);
  });

  test("blocks in strict mode when evidence is missing", () => {
    const cwd = tempWorkspace(false);
    const state = {
      ...baseState(),
      planArtifactPath: undefined,
      checkpoints: {
        ...baseState().checkpoints,
        hasPlanArtifact: false,
      },
    };

    const result = evaluateTddGate(cwd, state, "strict");

    expect(result.passed).toBe(false);
    expect(result.blocking).toBe(true);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  test("warns (non-blocking) in advisory mode", () => {
    const cwd = tempWorkspace(false);
    const state = {
      ...baseState(),
      planArtifactPath: undefined,
      checkpoints: {
        ...baseState().checkpoints,
        hasPlanArtifact: false,
      },
    };

    const result = evaluateTddGate(cwd, state, "advisory");

    expect(result.passed).toBe(false);
    expect(result.blocking).toBe(false);
  });
});
