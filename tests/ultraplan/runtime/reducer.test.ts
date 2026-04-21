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

function makeCursor(overrides: Partial<UltraPlanCursor> = {}): UltraPlanCursor {
  return {
    targetType: "scenario",
    stack: "frontend",
    domainId: "auth",
    level: "unit",
    scenarioId: "scenario-login-form-renders",
    phase: "red",
    status: "planned",
    summary: "frontend / auth / unit / scenario-login-form-renders",
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

function makeObservation(overrides: Partial<UltraPlanHookObservation> = {}): UltraPlanHookObservation {
  return {
    sessionId: "up-123",
    hookEvent: "tool_result",
    actorKind: "slot",
    attemptId: "att-1",
    attemptKey: "frontend/auth/unit/scenario-login-form-renders/red",
    sourceAgent: "sub-agent",
    occurredAt: "2026-04-19T12:00:01.000Z",
    causationId: "turn-1",
    fingerprint: "obs-fp-1",
    target: {
      targetType: "scenario",
      stack: "frontend",
      domainId: "auth",
      level: "unit",
      scenarioId: "scenario-login-form-renders",
      phase: "red",
      resolvedSlot: "frontend-tester",
    },
    correlationFailure: null,
    payloadSummary: "bun test: red failed",
    ...overrides,
  };
}

function makeProof(overrides: Partial<UltraPlanProofCandidate> = {}): UltraPlanProofCandidate {
  return {
    phase: "red",
    type: "test",
    target: {
      targetType: "scenario",
      stack: "frontend",
      domainId: "auth",
      level: "unit",
      scenarioId: "scenario-login-form-renders",
    },
    evidence: { summary: "red failed" },
    artifactRef: "artifact://red-1",
    observationFingerprint: "obs-fp-1",
    fingerprint: "proof-fp-1",
    ...overrides,
  };
}

function makeBlockerCandidate(code: string, overrides: Partial<UltraPlanBlockerCandidate> = {}): UltraPlanBlockerCandidate {
  return {
    blocker: {
      code,
      message: `test blocker ${code}`,
      scope: "scenario",
      affected: { stack: "frontend", domainId: "auth", level: "unit", scenarioId: "scenario-login-form-renders" },
      recoverable: true,
      recoveryMode: code === "proof-missing" ? "retry" : "manual",
      nextAction: "inspect",
      retryable: code === "proof-missing",
      detectedAt: "2026-04-19T12:00:02.000Z",
    },
    observationFingerprint: "obs-fp-1",
    ...overrides,
  };
}

function attemptWith(
  candidates: {
    proofs?: UltraPlanProofCandidate[];
    blockers?: UltraPlanBlockerCandidate[];
  },
): UltraPlanAttemptRecord {
  return {
    attemptId: "att-1",
    attemptKey: "frontend/auth/unit/scenario-login-form-renders/red",
    launchContext: {
      attemptId: "att-1",
      attemptKey: "frontend/auth/unit/scenario-login-form-renders/red",
      sourceAgent: "sub-agent",
      launchedAt: "2026-04-19T12:00:00.000Z",
    },
    cursorSnapshot: makeCursor({ status: "red-running" }),
    observations: [],
    proofCandidates: candidates.proofs ?? [],
    blockerCandidates: candidates.blockers ?? [],
    outcome: null,
    startedAt: "2026-04-19T12:00:00.000Z",
    finalizedAt: null,
  };
}

describe("reducer — attempt_started", () => {
  test("legal start: planned → red-running emits a start-attempt plan with cursor update", () => {
    const state: ReducerState = { tracker: makeTracker(), cursor: makeCursor({ status: "planned", phase: "red" }) };
    const plan = reduce(state, {
      kind: "attempt_started",
      observation: makeObservation({ hookEvent: "before_agent_start", fingerprint: "start-fp" }),
      launchContext: {
        attemptId: "att-1",
        attemptKey: "frontend/auth/unit/scenario-login-form-renders/red",
        sourceAgent: "sub-agent",
        launchedAt: "2026-04-19T12:00:00.000Z",
      },
    });
    expect(plan.kind).toBe("start-attempt");
    expect(plan.cursorUpdate?.status).toBe("red-running");
    expect(plan.appendObservationFingerprint).toBe("start-fp");
  });

  test("replay of an already-applied start observation is a persisted noop", () => {
    const state: ReducerState = {
      tracker: makeTracker({ appliedFingerprints: ["start-fp"] }),
      cursor: makeCursor({ status: "planned" }),
    };
    const plan = reduce(state, {
      kind: "attempt_started",
      observation: makeObservation({ hookEvent: "before_agent_start", fingerprint: "start-fp" }),
      launchContext: {
        attemptId: "att-1",
        attemptKey: "frontend/auth/unit/scenario-login-form-renders/red",
        sourceAgent: "sub-agent",
        launchedAt: "2026-04-19T12:00:00.000Z",
      },
    });
    expect(plan.kind).toBe("noop");
    expect(plan.appendObservationFingerprint).toBeNull();
  });

  test("attempt_started from a status that has no legal start transition emits a manual blocker", () => {
    const state: ReducerState = {
      tracker: makeTracker(),
      cursor: makeCursor({ status: "green-proved", phase: "complete" }),
    };
    const plan = reduce(state, {
      kind: "attempt_started",
      observation: makeObservation({ hookEvent: "before_agent_start", fingerprint: "start-fp2" }),
      launchContext: {
        attemptId: "att-1",
        attemptKey: "x",
        sourceAgent: "sub-agent",
        launchedAt: "2026-04-19T12:00:00.000Z",
      },
    });
    expect(plan.kind).toBe("block");
    expect(plan.blockerUpdate?.nextValue?.code).toBe("unsafe-repair-required");
  });
});

describe("reducer — observation_staged", () => {
  test("stages an observation fingerprint without mutating status", () => {
    const state: ReducerState = {
      tracker: makeTracker({ activeAttempt: attemptWith({}) }),
      cursor: makeCursor({ status: "red-running" }),
    };
    const plan = reduce(state, {
      kind: "observation_staged",
      observation: makeObservation({ fingerprint: "obs-fp-x" }),
    });
    expect(plan.kind).toBe("stage-observation");
    expect(plan.appendObservationFingerprint).toBe("obs-fp-x");
    expect(plan.scenarioStatusUpdate).toBeNull();
  });

  test("replay of already-applied observation is a noop", () => {
    const state: ReducerState = {
      tracker: makeTracker({ activeAttempt: attemptWith({}), appliedFingerprints: ["obs-fp-x"] }),
      cursor: makeCursor({ status: "red-running" }),
    };
    const plan = reduce(state, {
      kind: "observation_staged",
      observation: makeObservation({ fingerprint: "obs-fp-x" }),
    });
    expect(plan.kind).toBe("noop");
  });
});

describe("reducer — attempt_finalized", () => {
  test("red-phase proof advances red-running → red-proved", () => {
    const state: ReducerState = {
      tracker: makeTracker({ activeAttempt: attemptWith({ proofs: [makeProof()] }) }),
      cursor: makeCursor({ status: "red-running", phase: "red" }),
    };
    const plan = reduce(state, {
      kind: "attempt_finalized",
      observation: makeObservation({ hookEvent: "agent_end", fingerprint: "end-fp" }),
      nowIso: "2026-04-19T12:00:02.000Z",
    });
    expect(plan.kind).toBe("advance");
    expect(plan.scenarioStatusUpdate?.nextStatus).toBe("red-proved");
    expect(plan.scenarioStatusUpdate?.appendProof).toBeDefined();
    expect(plan.trackerAttemptFinalization?.outcome).toBe("advanced");
  });

  test("green-phase proof advances green-running → green-proved", () => {
    const state: ReducerState = {
      tracker: makeTracker({ activeAttempt: attemptWith({ proofs: [makeProof({ phase: "green", fingerprint: "p2" })] }) }),
      cursor: makeCursor({ status: "green-running", phase: "green" }),
    };
    const plan = reduce(state, {
      kind: "attempt_finalized",
      observation: makeObservation({ hookEvent: "agent_end", fingerprint: "end-fp-2" }),
      nowIso: "2026-04-19T12:00:03.000Z",
    });
    expect(plan.kind).toBe("advance");
    expect(plan.scenarioStatusUpdate?.nextStatus).toBe("green-proved");
  });

  test("missing proof produces an interrupted outcome (no advance)", () => {
    const state: ReducerState = {
      tracker: makeTracker({ activeAttempt: attemptWith({}) }),
      cursor: makeCursor({ status: "red-running" }),
    };
    const plan = reduce(state, {
      kind: "attempt_finalized",
      observation: makeObservation({ hookEvent: "agent_end", fingerprint: "end-fp-3" }),
      nowIso: "2026-04-19T12:00:02.000Z",
    });
    expect(plan.kind).toBe("interrupt");
    expect(plan.trackerAttemptFinalization?.outcome).toBe("interrupted");
    expect(plan.scenarioStatusUpdate).toBeNull();
  });

  test("explicit blocker candidate produces a block outcome", () => {
    const blocker = makeBlockerCandidate("proof-missing");
    const state: ReducerState = {
      tracker: makeTracker({ activeAttempt: attemptWith({ blockers: [blocker] }) }),
      cursor: makeCursor({ status: "red-running" }),
    };
    const plan = reduce(state, {
      kind: "attempt_finalized",
      observation: makeObservation({ hookEvent: "agent_end", fingerprint: "end-fp-b" }),
      nowIso: "2026-04-19T12:00:02.000Z",
    });
    expect(plan.kind).toBe("block");
    expect(plan.blockerUpdate?.nextValue?.code).toBe("proof-missing");
    expect(plan.trackerAttemptFinalization?.outcome).toBe("blocked");
  });

  test("conflicting evidence (proof + blocker) fails closed with a manual conflicting-evidence blocker", () => {
    const state: ReducerState = {
      tracker: makeTracker({
        activeAttempt: attemptWith({
          proofs: [makeProof()],
          blockers: [makeBlockerCandidate("proof-invalid")],
        }),
      }),
      cursor: makeCursor({ status: "red-running" }),
    };
    const plan = reduce(state, {
      kind: "attempt_finalized",
      observation: makeObservation({ hookEvent: "agent_end", fingerprint: "end-fp-c" }),
      nowIso: "2026-04-19T12:00:02.000Z",
    });
    expect(plan.kind).toBe("block");
    expect(plan.blockerUpdate?.nextValue?.code).toBe("conflicting-evidence");
    expect(plan.blockerUpdate?.nextValue?.recoveryMode).toBe("manual");
    expect(plan.scenarioStatusUpdate).toBeNull();
  });

  test("replay of an already-applied finalization observation is a noop", () => {
    const state: ReducerState = {
      tracker: makeTracker({
        activeAttempt: attemptWith({ proofs: [makeProof()] }),
        appliedFingerprints: ["end-fp-already"],
      }),
      cursor: makeCursor({ status: "red-running" }),
    };
    const plan = reduce(state, {
      kind: "attempt_finalized",
      observation: makeObservation({ hookEvent: "agent_end", fingerprint: "end-fp-already" }),
      nowIso: "2026-04-19T12:00:02.000Z",
    });
    expect(plan.kind).toBe("noop");
  });
});

describe("reducer — session_shutdown", () => {
  test("marks an in-flight active attempt as interrupted", () => {
    const state: ReducerState = {
      tracker: makeTracker({ activeAttempt: attemptWith({}) }),
      cursor: makeCursor({ status: "red-running" }),
    };
    const plan = reduce(state, {
      kind: "session_shutdown",
      observation: makeObservation({ hookEvent: "session_shutdown", fingerprint: "shut-1", actorKind: "main-orchestrator", attemptId: null, attemptKey: null, target: null }),
      nowIso: "2026-04-19T13:00:00.000Z",
    });
    expect(plan.kind).toBe("interrupt");
    expect(plan.trackerAttemptFinalization?.outcome).toBe("interrupted");
  });

  test("with no active attempt is a noop", () => {
    const state: ReducerState = { tracker: makeTracker(), cursor: makeCursor() };
    const plan = reduce(state, {
      kind: "session_shutdown",
      observation: makeObservation({ hookEvent: "session_shutdown", fingerprint: "shut-2", actorKind: "main-orchestrator", attemptId: null, attemptKey: null, target: null }),
      nowIso: "2026-04-19T13:00:00.000Z",
    });
    expect(plan.kind).toBe("noop");
  });
});

describe("reducer — purity and repair pass-through", () => {
  test("reduce is pure: returns a plain object and performs no I/O", () => {
    const state: ReducerState = {
      tracker: makeTracker({ activeAttempt: attemptWith({ proofs: [makeProof()] }) }),
      cursor: makeCursor({ status: "red-running" }),
    };
    const plan = reduce(state, {
      kind: "attempt_finalized",
      observation: makeObservation({ hookEvent: "agent_end", fingerprint: "end-fp-pure" }),
      nowIso: "2026-04-19T12:00:02.000Z",
    });
    expect(typeof plan).toBe("object");
    expect(plan).not.toBeNull();
  });

  test("repair_applied passes through provided repair actions as a repair plan", () => {
    const state: ReducerState = { tracker: makeTracker(), cursor: makeCursor() };
    const plan = reduce(state, {
      kind: "repair_applied",
      nowIso: "2026-04-19T12:00:00.000Z",
      details: {
        reason: "stale cursor at terminal scenario",
        actions: [{ op: "recompute-cursor", reason: "stale" }],
      },
    });
    expect(plan.kind).toBe("repair");
    expect(plan.repairActions.length).toBe(1);
  });
});
