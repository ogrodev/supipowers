import { describe, expect, test } from "bun:test";
import type {
  UltraPlanAttemptRecord,
  UltraPlanBlockerCandidate,
  UltraPlanCursor,
  UltraPlanHookObservation,
  UltraPlanProofCandidate,
  UltraPlanRuntimeTracker,
} from "../../../src/types.js";
import { reduce, type ReducerState } from "../../../src/ultraplan/runtime/reducer.js";
import { repairOnSessionStart } from "../../../src/ultraplan/runtime/repair.js";
import { extractProofCandidate } from "../../../src/ultraplan/runtime/proof.js";
import { normalizeHookEvent } from "../../../src/ultraplan/runtime/normalize.js";

/**
 * Adversarial families from the approved Slice-2 runtime spec §testing 4. Each family asserts a
 * specific rule in the runtime. The rule's absence would flip the expected outcome \u2014 for
 * example, if the reducer's \"proof + blocker = manual\" rule were disabled, the conflicting
 * evidence test below would observe an \"advance\" outcome instead of \"block\".
 */

function cursor(overrides: Partial<UltraPlanCursor> = {}): UltraPlanCursor {
  return {
    targetType: "scenario",
    stack: "frontend",
    domainId: "auth",
    level: "unit",
    scenarioId: "s",
    phase: "red",
    status: "red-running",
    summary: "s",
    ...overrides,
  };
}

function observation(overrides: Partial<UltraPlanHookObservation> = {}): UltraPlanHookObservation {
  return {
    sessionId: "up",
    hookEvent: "agent_end",
    actorKind: "slot",
    attemptId: "att-1",
    attemptKey: "k",
    sourceAgent: "sub-agent",
    occurredAt: "2026-04-19T12:00:02.000Z",
    causationId: null,
    fingerprint: "end-fp",
    target: null,
    correlationFailure: null,
    payloadSummary: "",
    ...overrides,
  };
}

function proof(overrides: Partial<UltraPlanProofCandidate> = {}): UltraPlanProofCandidate {
  return {
    phase: "red",
    type: "test",
    target: { targetType: "scenario", stack: "frontend", domainId: "auth", level: "unit", scenarioId: "s" },
    evidence: { summary: "x" },
    artifactRef: null,
    observationFingerprint: "obs-fp",
    fingerprint: "p-fp",
    ...overrides,
  };
}

function blockerCandidate(code: string): UltraPlanBlockerCandidate {
  return {
    blocker: {
      code,
      message: "b",
      scope: "scenario",
      affected: { stack: "frontend", domainId: "auth", level: "unit", scenarioId: "s" },
      recoverable: true,
      recoveryMode: "manual",
      nextAction: "x",
      retryable: false,
      detectedAt: "2026-04-19T12:00:02.000Z",
    },
    observationFingerprint: "obs-fp",
  };
}

function tracker(overrides: Partial<UltraPlanRuntimeTracker> = {}): UltraPlanRuntimeTracker {
  return {
    version: 1,
    sessionId: "up",
    activeAttempt: null,
    finalizedAttempts: [],
    appliedFingerprints: [],
    pendingMutation: null,
    updatedAt: "2026-04-19T12:00:00.000Z",
    ...overrides,
  };
}

function attemptWith(parts: { proofs?: UltraPlanProofCandidate[]; blockers?: UltraPlanBlockerCandidate[] }): UltraPlanAttemptRecord {
  return {
    attemptId: "att-1",
    attemptKey: "k",
    launchContext: { attemptId: "att-1", attemptKey: "k", sourceAgent: "sub-agent", launchedAt: "2026-04-19T12:00:00.000Z" },
    cursorSnapshot: null,
    observations: [],
    proofCandidates: parts.proofs ?? [],
    blockerCandidates: parts.blockers ?? [],
    outcome: null,
    startedAt: "2026-04-19T12:00:00.000Z",
    finalizedAt: null,
  };
}

describe("adversarial — ambiguous correlation", () => {
  test("slot-backed event with no launch-context carrier surfaces a correlation failure (no silent advancement)", () => {
    const obs = normalizeHookEvent({
      hookEvent: "tool_result",
      sessionId: "up",
      nowIso: "2026-04-19T12:00:01.000Z",
      metadata: null,
      prompt: null,
      persistedActiveAttempt: null,
      payload: { toolName: "bash" },
      targetHint: {
        targetType: "scenario",
        stack: "frontend",
        domainId: "auth",
        level: "unit",
        scenarioId: "s",
        phase: "red",
        resolvedSlot: "frontend-tester",
        actorKind: "slot",
        sourceAgent: "sub-agent",
      },
    });
    expect(obs.attemptId).toBeNull();
    expect(obs.correlationFailure).not.toBeNull();
  });
});

describe("adversarial — wrong-phase proof", () => {
  test("green-phase proof for a red-running cursor is rejected as proof-invalid", () => {
    const result = extractProofCandidate({
      observation: observation({ target: { targetType: "scenario", stack: "frontend", domainId: "auth", level: "unit", scenarioId: "s", phase: "red", resolvedSlot: null } }),
      payload: { proof: { type: "test", phase: "green", evidence: { summary: "wrong phase" }, artifactRef: "a" } },
      expectedTarget: { targetType: "scenario", stack: "frontend", domainId: "auth", level: "unit", scenarioId: "s" },
      expectedPhase: "red",
    });
    expect(result.kind).toBe("blocker-candidate");
    if (result.kind === "blocker-candidate") {
      expect(result.blocker.blocker.code).toBe("proof-invalid");
    }
  });
});

describe("adversarial — conflicting evidence", () => {
  test("proof + blocker in a single attempt finalization fails closed with a manual blocker", () => {
    const state: ReducerState = {
      tracker: tracker({ activeAttempt: attemptWith({ proofs: [proof()], blockers: [blockerCandidate("proof-invalid")] }) }),
      cursor: cursor(),
    };
    const plan = reduce(state, { kind: "attempt_finalized", observation: observation(), nowIso: "2026-04-19T12:00:02.000Z" });
    expect(plan.kind).toBe("block");
    expect(plan.blockerUpdate?.nextValue?.code).toBe("conflicting-evidence");
    expect(plan.blockerUpdate?.nextValue?.recoveryMode).toBe("manual");
    // Critical: no scenarioStatusUpdate \u2014 nothing advances.
    expect(plan.scenarioStatusUpdate).toBeNull();
  });
});

describe("adversarial — persistence failure during finalization", () => {
  test("a finalization whose persistence fails does not update appliedFingerprints (rollback-safe)", () => {
    // The reducer produces a plan with `appendObservationFingerprint`. Simulating a persistence
    // failure means the tracker write does not land \u2014 on reload, appliedFingerprints must still be
    // the pre-failure state. We assert that the reducer itself does not mutate the input tracker.
    const initialTracker = tracker({
      activeAttempt: attemptWith({ proofs: [proof()] }),
      appliedFingerprints: [],
    });
    const frozenBefore = JSON.stringify(initialTracker);
    const state: ReducerState = { tracker: initialTracker, cursor: cursor() };
    reduce(state, { kind: "attempt_finalized", observation: observation(), nowIso: "2026-04-19T12:00:02.000Z" });
    const frozenAfter = JSON.stringify(initialTracker);
    expect(frozenAfter).toBe(frozenBefore);
  });
});

describe("adversarial — stale active attempt pointing at terminal work", () => {
  test("repair converts an orphaned in-flight attempt to interrupted without advancing terminal scenario", () => {
    const plan = repairOnSessionStart(
      {
        tracker: tracker({ activeAttempt: attemptWith({ proofs: [proof()] }) }),
        manifest: null,
      },
      "2026-04-19T12:30:00.000Z",
    );
    expect(plan.activeAttemptAction).toBe("finalize-as-interrupted");
    // Critical: no repair action promotes the scenario to terminal without a full reducer pass.
    const forbidden = plan.actions.some((a) => a.op !== "recompute-cursor"
      && a.op !== "recompute-progress"
      && a.op !== "clear-active-attempt"
      && a.op !== "convert-active-to-interrupted"
      && a.op !== "clear-blocker");
    expect(forbidden).toBe(false);
  });
});
