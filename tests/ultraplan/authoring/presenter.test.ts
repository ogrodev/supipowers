import { describe, expect, test } from "bun:test";

import { renderUltraPlanAuthoringStatus } from "../../../src/ultraplan/presenter.js";
import type {
  UltraPlanAuthoringPipelineEvent,
  UltraPlanAuthoringState,
} from "../../../src/types.js";

function state(overrides: Partial<UltraPlanAuthoringState> = {}): UltraPlanAuthoringState {
  return {
    pipeline: "multi-stage",
    stage: "scout",
    stageStatus: "done",
    iteration: 1,
    stallReentryCount: 0,
    artifacts: { intake: "authoring/intake.json", scout: "authoring/scout.json" },
    blocker: null,
    startedAt: "2026-04-30T10:00:00.000Z",
    updatedAt: "2026-04-30T10:05:00.000Z",
    ...overrides,
  };
}

describe("renderUltraPlanAuthoringStatus", () => {
  test("renders core fields and the next action for a completed scout stage", () => {
    const out = renderUltraPlanAuthoringStatus("up-1", state());
    expect(out.includes("Session: up-1")).toBe(true);
    expect(out.includes("Stage: scout")).toBe(true);
    expect(out.includes("Status: done")).toBe(true);
    expect(out.includes("Iteration: 1")).toBe(true);
    expect(out.includes("Artifacts: intake, scout")).toBe(true);
    expect(out.includes("Next action: Run discover")).toBe(true);
  });

  test("renders awaiting-user as 'Confirm <stage> to advance'", () => {
    const out = renderUltraPlanAuthoringStatus("up-2", state({ stage: "synthesize", stageStatus: "awaiting-user" }));
    expect(out.includes("Next action: Confirm synthesize to advance")).toBe(true);
  });

  test("renders blocker section when present", () => {
    const blocker = {
      code: "research-incomplete",
      message: "backend researcher failed",
      scope: "session",
      affected: { stack: "backend", domainId: null, level: null, scenarioId: null },
      recoverable: true,
      recoveryMode: "retry",
      nextAction: "Re-run research",
      retryable: true,
      detectedAt: "2026-04-30T10:10:00.000Z",
    } as unknown as UltraPlanAuthoringState["blocker"];

    const out = renderUltraPlanAuthoringStatus(
      "up-3",
      state({ stage: "research", stageStatus: "blocked", blocker: blocker as never }),
    );
    expect(out.includes("Blocker: research-incomplete")).toBe(true);
    expect(out.includes("Recovery: retry")).toBe(true);
  });

  test("renders 'Approval pending' for completed approve stage", () => {
    const out = renderUltraPlanAuthoringStatus("up-4", state({ stage: "approve", stageStatus: "done" }));
    expect(out.includes("Next action: Approval pending")).toBe(true);
  });

  test("includes recent pipeline events when provided", () => {
    const events: UltraPlanAuthoringPipelineEvent[] = [
      {
        recordedAt: "2026-04-30T10:00:00.000Z",
        stage: "intake",
        stageStatus: "done",
        iteration: 1,
        summary: "intake complete",
      },
      {
        recordedAt: "2026-04-30T10:05:00.000Z",
        stage: "scout",
        stageStatus: "done",
        iteration: 1,
        summary: "scout complete",
      },
    ];
    const out = renderUltraPlanAuthoringStatus("up-5", state(), events);
    expect(out.includes("Recent pipeline events:")).toBe(true);
    expect(out.includes("intake complete")).toBe(true);
    expect(out.includes("scout complete")).toBe(true);
  });

  test("stall re-entry count is rendered when > 0", () => {
    const out = renderUltraPlanAuthoringStatus("up-6", state({ stallReentryCount: 2 }));
    expect(out.includes("Stall re-entries: 2")).toBe(true);
  });

  test("missing artifacts renders an em-dash", () => {
    const out = renderUltraPlanAuthoringStatus("up-7", state({ artifacts: {} }));
    expect(out.includes("Artifacts: \u2014")).toBe(true);
  });
});
