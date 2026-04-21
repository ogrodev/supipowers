import { describe, expect, test } from "bun:test";
import type {
  UltraPlanAttemptRecord,
  UltraPlanBlocker,
  UltraPlanManifest,
  UltraPlanRuntimeTracker,
} from "../../../src/types.js";
import {
  repairOnSessionShutdown,
  repairOnSessionStart,
  type RepairState,
} from "../../../src/ultraplan/runtime/repair.js";

function makeActive(overrides: Partial<UltraPlanAttemptRecord> = {}): UltraPlanAttemptRecord {
  return {
    attemptId: "att-1",
    attemptKey: "frontend/auth/unit/s/red",
    launchContext: {
      attemptId: "att-1",
      attemptKey: "frontend/auth/unit/s/red",
      sourceAgent: "sub-agent",
      launchedAt: "2026-04-19T12:00:00.000Z",
    },
    cursorSnapshot: null,
    observations: [],
    proofCandidates: [],
    blockerCandidates: [],
    outcome: null,
    startedAt: "2026-04-19T12:00:00.000Z",
    finalizedAt: null,
    ...overrides,
  };
}

function makeTracker(overrides: Partial<UltraPlanRuntimeTracker> = {}): UltraPlanRuntimeTracker {
  return {
    version: 1,
    sessionId: "up-123",
    activeAttempt: null,
    finalizedAttempts: [],
    appliedFingerprints: [],
    pendingMutation: null,
    updatedAt: "2026-04-19T12:00:00.000Z",
    ...overrides,
  };
}

describe("repairOnSessionStart", () => {
  test("converts an orphaned active attempt into an interrupted ledger entry", () => {
    const state: RepairState = {
      tracker: makeTracker({ activeAttempt: makeActive() }),
      manifest: null,
    };
    const plan = repairOnSessionStart(state, "2026-04-19T12:30:00.000Z");
    expect(plan.activeAttemptAction).toBe("finalize-as-interrupted");
    expect(plan.actions.some((a) => a.op === "convert-active-to-interrupted")).toBe(true);
    expect(plan.emittedBlockers).toEqual([]);
  });

  test("is a noop when there is no active attempt and no staged pendingMutation", () => {
    const state: RepairState = { tracker: makeTracker(), manifest: null };
    const plan = repairOnSessionStart(state, "2026-04-19T12:30:00.000Z");
    expect(plan.actions.length).toBe(0);
    expect(plan.emittedBlockers.length).toBe(0);
    expect(plan.activeAttemptAction).toBe("leave");
  });

  test("emits an unsafe-repair-required blocker when activeAttempt has proof+blocker candidates that conflict (cannot safely repair)", () => {
    const state: RepairState = {
      tracker: makeTracker({
        activeAttempt: makeActive({
          proofCandidates: [{
            phase: "red",
            type: "test",
            target: { targetType: "scenario", stack: "frontend", domainId: "auth", level: "unit", scenarioId: "s" },
            evidence: { summary: "red proof" },
            artifactRef: null,
            observationFingerprint: "fp-p",
            fingerprint: "pf-1",
          }],
          blockerCandidates: [{
            blocker: {
              code: "proof-invalid",
              message: "contradicts proof",
              scope: "scenario",
              affected: { stack: "frontend", domainId: "auth", level: "unit", scenarioId: "s" },
              recoverable: true,
              recoveryMode: "manual",
              nextAction: "inspect",
              retryable: false,
              detectedAt: "2026-04-19T12:00:02.000Z",
            },
            observationFingerprint: "fp-b",
          }],
        }),
      }),
      manifest: null,
    };
    const plan = repairOnSessionStart(state, "2026-04-19T12:30:00.000Z");
    expect(plan.emittedBlockers.length).toBeGreaterThan(0);
    expect(plan.emittedBlockers[0].code).toBe("unsafe-repair-required");
    // It must NOT silently finalize the attempt as advanced.
    expect(plan.activeAttemptAction).not.toBe("leave"); // it still carries forward as interrupted or blocked
  });

  test("never emits a repair action that promotes a scenario to a terminal status", () => {
    const state: RepairState = {
      tracker: makeTracker({ activeAttempt: makeActive({ proofCandidates: [{
        phase: "red",
        type: "test",
        target: { targetType: "scenario", stack: "frontend", domainId: "auth", level: "unit", scenarioId: "s" },
        evidence: { summary: "red proof" },
        artifactRef: null,
        observationFingerprint: "fp-p",
        fingerprint: "pf-1",
      }] }) }),
      manifest: null,
    };
    const plan = repairOnSessionStart(state, "2026-04-19T12:30:00.000Z");
    // Repair never invents a scenario advance: the reducer owns advancement decisions.
    const illegalOps = plan.actions.filter((a) =>
      a.op !== "recompute-cursor"
      && a.op !== "recompute-progress"
      && a.op !== "clear-active-attempt"
      && a.op !== "convert-active-to-interrupted"
      && a.op !== "clear-blocker"
    );
    expect(illegalOps.length).toBe(0);
  });

  test("clears a blocker only when a later proof on the same target exists", () => {
    // Case A: blocker persists because there is no later proof — repair must not touch it.
    const blocker: UltraPlanBlocker = {
      code: "proof-missing",
      message: "b",
      scope: "scenario",
      affected: { stack: "frontend", domainId: "auth", level: "unit", scenarioId: "s" },
      recoverable: true,
      recoveryMode: "retry",
      nextAction: "retry",
      retryable: true,
      detectedAt: "2026-04-19T11:00:00.000Z",
    };
    const manifest: UltraPlanManifest = manifestWithBlocker(blocker, []);
    const stateA: RepairState = { tracker: makeTracker(), manifest };
    const planA = repairOnSessionStart(stateA, "2026-04-19T12:30:00.000Z");
    expect(planA.actions.find((a) => a.op === "clear-blocker")).toBeUndefined();

    // Case B: a later proof on the same target — repair clears the stale blocker.
    const finalizedAttempt: UltraPlanAttemptRecord = makeActive({
      outcome: "advanced",
      finalizedAt: "2026-04-19T11:30:00.000Z",
      proofCandidates: [{
        phase: "red",
        type: "test",
        target: { targetType: "scenario", stack: "frontend", domainId: "auth", level: "unit", scenarioId: "s" },
        evidence: { summary: "red proof" },
        artifactRef: null,
        observationFingerprint: "fp-p",
        fingerprint: "pf-1",
      }],
    });
    const stateB: RepairState = {
      tracker: makeTracker({ finalizedAttempts: [finalizedAttempt] }),
      manifest,
    };
    const planB = repairOnSessionStart(stateB, "2026-04-19T12:30:00.000Z");
    expect(planB.actions.find((a) => a.op === "clear-blocker")).toBeDefined();
  });
});

describe("repairOnSessionShutdown", () => {
  test("converts an in-flight active attempt into an interrupted ledger entry", () => {
    const state: RepairState = {
      tracker: makeTracker({ activeAttempt: makeActive() }),
      manifest: null,
    };
    const plan = repairOnSessionShutdown(state, "2026-04-19T13:00:00.000Z");
    expect(plan.activeAttemptAction).toBe("finalize-as-interrupted");
    expect(plan.actions.some((a) => a.op === "convert-active-to-interrupted")).toBe(true);
  });

  test("is a noop when there is no active attempt", () => {
    const state: RepairState = { tracker: makeTracker(), manifest: null };
    const plan = repairOnSessionShutdown(state, "2026-04-19T13:00:00.000Z");
    expect(plan.actions.length).toBe(0);
    expect(plan.activeAttemptAction).toBe("leave");
  });
});

function manifestWithBlocker(blocker: UltraPlanBlocker, reviews: UltraPlanManifest["reviews"]): UltraPlanManifest {
  return {
    sessionId: "up-123",
    projectName: "supipowers",
    title: "t",
    authored: { json: "authored.json" },
    state: "blocked",
    cursor: {
      targetType: "scenario",
      stack: "frontend",
      domainId: "auth",
      level: "unit",
      scenarioId: "s",
      phase: "red",
      status: "blocked",
      summary: "blocked",
    },
    lastCompleted: null,
    progress: { total: 1, terminal: 0, blocked: 1 },
    stacks: [],
    blocker,
    reviews,
    createdAt: "2026-04-19T10:00:00.000Z",
    updatedAt: "2026-04-19T11:00:00.000Z",
  };
}
