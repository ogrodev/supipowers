import type {
  UltraPlanAttemptRecord,
  UltraPlanBlockerCandidate,
  UltraPlanCursor,
  UltraPlanHookObservation,
  UltraPlanMutationPlan,
  UltraPlanProofCandidate,
  UltraPlanReducerAction,
  UltraPlanRuntimeTracker,
  UltraPlanScenarioStatus,
} from "../../types.js";
import {
  buildConflictingEvidenceBlocker,
  buildInterruptedAttemptBlocker,
  buildProofMissingBlocker,
  buildUnsafeRepairRequiredBlocker,
} from "./blockers.js";

/**
 * Slice-2 pure reducer.
 *
 * Decides, given the current state and a validated action, what the persisted mutation should
 * be. The reducer performs no I/O; its output is consumed by the hook bridge's
 * `applyMutationPlan` seam which runs the durability order. See approved spec §reducer outcome
 * precedence (lines 562–572) and §transition rules.
 */

export interface ReducerState {
  tracker: UltraPlanRuntimeTracker;
  cursor: UltraPlanCursor | null;
}

export function reduce(state: ReducerState, action: UltraPlanReducerAction): UltraPlanMutationPlan {
  if (state.cursor?.targetType === "session" && state.cursor.status === "complete") {
    return buildPlan({
      kind: "complete",
      rationale: "cursor already resolved to session complete",
      cursorUpdate: state.cursor,
      sessionStateUpdate: "complete",
    });
  }

  switch (action.kind) {
    case "session_started":
      return buildPlan({ kind: "noop", rationale: "session_started observed; repair runs separately" });
    case "attempt_started":
      return reduceAttemptStarted(state, action);
    case "observation_staged":
      return reduceObservationStaged(state, action);
    case "attempt_finalized":
      return reduceAttemptFinalized(state, action);
    case "session_shutdown":
      return reduceSessionShutdown(state, action);
    case "repair_applied":
      return buildPlan({
        kind: "repair",
        rationale: action.details.reason,
        repairActions: action.details.actions,
      });
  }
}

// ---------------------------------------------------------------------------
// attempt_started
// ---------------------------------------------------------------------------

function reduceAttemptStarted(
  state: ReducerState,
  action: Extract<UltraPlanReducerAction, { kind: "attempt_started" }>,
): UltraPlanMutationPlan {
  const { observation } = action;

  if (alreadyApplied(state.tracker, observation.fingerprint)) {
    return buildPlan({
      kind: "noop",
      rationale: `attempt_started observation ${observation.fingerprint} already applied`,
    });
  }

  if (state.tracker.activeAttempt) {
    return buildPlan({
      kind: "block",
      rationale: `nested before_agent_start observed while attempt ${state.tracker.activeAttempt.attemptId} is still active`,
      blockerUpdate: {
        scope: "session",
        nextValue: buildUnsafeRepairRequiredBlocker({
          detectedAt: observation.occurredAt,
          scope: "session",
          reason: `active attempt ${state.tracker.activeAttempt.attemptId} must finalize before a new attempt starts`,
        }),
        clearedByObservationFingerprint: null,
      },
      sessionStateUpdate: "blocked",
      appendObservationFingerprint: observation.fingerprint,
    });
  }

  const cursor = state.cursor;
  if (!cursor || !isLegalStartFromCursor(cursor)) {
    return buildPlan({
      kind: "block",
      rationale: "attempt_started from a cursor that has no legal-start transition",
      blockerUpdate: {
        scope: "session",
        nextValue: buildUnsafeRepairRequiredBlocker({
          detectedAt: observation.occurredAt,
          scope: "session",
          reason: `cursor status ${cursor?.status ?? "null"} has no legal-start transition`,
        }),
        clearedByObservationFingerprint: null,
      },
      sessionStateUpdate: "blocked",
      appendObservationFingerprint: observation.fingerprint,
    });
  }

  const nextStatus = legalStartNextStatus(cursor);
  return buildPlan({
    kind: "start-attempt",
    rationale: `legal start: ${cursor.status} -> ${nextStatus}`,
    cursorUpdate: { ...cursor, status: nextStatus, phase: phaseForStatus(nextStatus, cursor.phase) },
    sessionStateUpdate: "running",
    appendObservationFingerprint: observation.fingerprint,
  });
}

// ---------------------------------------------------------------------------
// observation_staged
// ---------------------------------------------------------------------------

function reduceObservationStaged(
  state: ReducerState,
  action: Extract<UltraPlanReducerAction, { kind: "observation_staged" }>,
): UltraPlanMutationPlan {
  const { observation } = action;
  if (alreadyApplied(state.tracker, observation.fingerprint)) {
    return buildPlan({ kind: "noop", rationale: "observation already applied" });
  }
  return buildPlan({
    kind: "stage-observation",
    rationale: `stage observation ${observation.fingerprint}`,
    appendObservationFingerprint: observation.fingerprint,
  });
}

// ---------------------------------------------------------------------------
// attempt_finalized  (precedence: conflicting -> proof -> blocker -> interrupted -> noop)
// ---------------------------------------------------------------------------

function reduceAttemptFinalized(
  state: ReducerState,
  action: Extract<UltraPlanReducerAction, { kind: "attempt_finalized" }>,
): UltraPlanMutationPlan {
  const { observation, nowIso } = action;
  if (alreadyApplied(state.tracker, observation.fingerprint)) {
    return buildPlan({ kind: "noop", rationale: "attempt_finalized already applied" });
  }

  const active = state.tracker.activeAttempt;
  if (!active) {
    return buildPlan({
      kind: "noop",
      rationale: "attempt_finalized observed without an active attempt; treated as replay",
    });
  }

  const proofs = active.proofCandidates;
  const blockers = active.blockerCandidates;
  const cursor = state.cursor;

  // Rule 1 — conflicting evidence: fail closed.
  if (proofs.length > 0 && blockers.length > 0) {
    return buildPlan({
      kind: "block",
      rationale: "conflicting evidence: proof and blocker in the same attempt finalization",
      blockerUpdate: {
        scope: "scenario",
        nextValue: buildConflictingEvidenceBlocker({
          detectedAt: nowIso,
          scope: "scenario",
          affected: cursor ? toAffected(cursor) : undefined,
          reason: "valid proof and blocker candidate observed in same attempt",
        }),
        clearedByObservationFingerprint: null,
      },
      trackerAttemptFinalization: { attemptId: active.attemptId, outcome: "blocked", finalizedAt: nowIso },
      sessionStateUpdate: "blocked",
      appendObservationFingerprint: observation.fingerprint,
    });
  }

  // Rule 2 — valid proof for the current target/phase advances scenario status.
  if (proofs.length > 0 && cursor) {
    const proof = pickProofForCursor(proofs, cursor);
    if (proof) {
      const nextStatus = provedStatusForPhase(proof.phase);
      if (nextStatus) {
        return buildPlan({
          kind: "advance",
          rationale: `${proof.phase}-phase proof matched cursor; advancing to ${nextStatus}`,
          scenarioStatusUpdate: {
            stack: cursor.stack!,
            domainId: cursor.domainId!,
            level: cursor.level!,
            scenarioId: cursor.scenarioId!,
            nextStatus,
            appendProof: {
              type: proof.type,
              phase: proof.phase,
              recordedAt: observation.occurredAt,
              actor: observation.target?.resolvedSlot ?? "frontend-executor",
              evidence: proof.evidence,
              artifactRef: proof.artifactRef ?? `artifact://${proof.phase}-${active.attemptId}`,
            },
          },
          cursorUpdate: advancedCursor(cursor, nextStatus),
          trackerAttemptFinalization: { attemptId: active.attemptId, outcome: "advanced", finalizedAt: nowIso },
          recomputeProgress: true,
          appendObservationFingerprint: observation.fingerprint,
        });
      }
    }
  }

  // Rule 3 — explicit blocker candidate.
  if (blockers.length > 0) {
    const candidate = blockers[0];
    return buildPlan({
      kind: "block",
      rationale: `explicit blocker candidate ${candidate.blocker.code}`,
      blockerUpdate: {
        scope: candidate.blocker.scope,
        nextValue: candidate.blocker,
        clearedByObservationFingerprint: null,
      },
      trackerAttemptFinalization: { attemptId: active.attemptId, outcome: "blocked", finalizedAt: nowIso },
      sessionStateUpdate: candidate.blocker.recoveryMode === "await-user" ? "awaiting-user" : "blocked",
      appendObservationFingerprint: observation.fingerprint,
    });
  }

  // Rule 4 — no proof, no blocker: interrupted outcome. Do NOT silently advance.
  const interruptedBlocker = buildInterruptedAttemptBlocker({
    detectedAt: nowIso,
    scope: "scenario",
    affected: cursor ? toAffected(cursor) : undefined,
    attemptId: active.attemptId,
  });
  return buildPlan({
    kind: "interrupt",
    rationale: "no proof and no blocker observed; attempt interrupted",
    blockerUpdate: {
      scope: "scenario",
      nextValue: interruptedBlocker,
      clearedByObservationFingerprint: null,
    },
    trackerAttemptFinalization: { attemptId: active.attemptId, outcome: "interrupted", finalizedAt: nowIso },
    sessionStateUpdate: "blocked",
    appendObservationFingerprint: observation.fingerprint,
    notes: [`missing-proof: ${buildProofMissingBlocker({ detectedAt: nowIso, expectedPhase: inferPhase(cursor) }).message}`],
  });
}

// ---------------------------------------------------------------------------
// session_shutdown
// ---------------------------------------------------------------------------

function reduceSessionShutdown(
  state: ReducerState,
  action: Extract<UltraPlanReducerAction, { kind: "session_shutdown" }>,
): UltraPlanMutationPlan {
  const active = state.tracker.activeAttempt;
  if (!active) {
    return buildPlan({ kind: "noop", rationale: "session_shutdown with no active attempt" });
  }
  const interruptedBlocker = buildInterruptedAttemptBlocker({
    detectedAt: action.nowIso,
    scope: "scenario",
    affected: state.cursor ? toAffected(state.cursor) : undefined,
    attemptId: active.attemptId,
    reason: "session shut down with in-flight active attempt",
  });
  return buildPlan({
    kind: "interrupt",
    rationale: `session_shutdown interrupted attempt ${active.attemptId}`,
    blockerUpdate: {
      scope: "scenario",
      nextValue: interruptedBlocker,
      clearedByObservationFingerprint: null,
    },
    trackerAttemptFinalization: { attemptId: active.attemptId, outcome: "interrupted", finalizedAt: action.nowIso },
    sessionStateUpdate: "blocked",
    appendObservationFingerprint: action.observation.fingerprint,
  });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface PlanBuilderInput {
  kind: UltraPlanMutationPlan["kind"];
  rationale: string;
  appendObservationFingerprint?: string | null;
  scenarioStatusUpdate?: UltraPlanMutationPlan["scenarioStatusUpdate"];
  reviewStatusUpdate?: UltraPlanMutationPlan["reviewStatusUpdate"];
  blockerUpdate?: UltraPlanMutationPlan["blockerUpdate"];
  cursorUpdate?: UltraPlanMutationPlan["cursorUpdate"];
  sessionStateUpdate?: UltraPlanMutationPlan["sessionStateUpdate"];
  trackerAttemptFinalization?: UltraPlanMutationPlan["trackerAttemptFinalization"];
  recomputeProgress?: boolean;
  repairActions?: UltraPlanMutationPlan["repairActions"];
  notes?: string[];
}

function buildPlan(input: PlanBuilderInput): UltraPlanMutationPlan {
  return {
    kind: input.kind,
    rationale: input.rationale,
    appendObservationFingerprint: input.appendObservationFingerprint ?? null,
    scenarioStatusUpdate: input.scenarioStatusUpdate ?? null,
    reviewStatusUpdate: input.reviewStatusUpdate ?? null,
    blockerUpdate: input.blockerUpdate ?? null,
    cursorUpdate: input.cursorUpdate ?? null,
    sessionStateUpdate: input.sessionStateUpdate ?? null,
    trackerAttemptFinalization: input.trackerAttemptFinalization ?? null,
    recomputeProgress: input.recomputeProgress ?? false,
    repairActions: input.repairActions ?? [],
    notes: input.notes ?? [],
  };
}

function alreadyApplied(tracker: UltraPlanRuntimeTracker, fingerprint: string): boolean {
  return tracker.appliedFingerprints.includes(fingerprint);
}

function isLegalStartFromCursor(cursor: UltraPlanCursor): boolean {
  // Legal-start transitions per spec §transition classes:
  //   planned -> red-running
  //   red-proved -> green-running
  //   review pending -> running
  if (cursor.targetType === "scenario") {
    return cursor.status === "planned" || cursor.status === "red-proved";
  }
  if (cursor.targetType === "domain-review" || cursor.targetType === "stack-review") {
    return cursor.status === "pending";
  }
  return false;
}

function legalStartNextStatus(cursor: UltraPlanCursor): UltraPlanCursor["status"] {
  if (cursor.targetType === "scenario") {
    if (cursor.status === "planned") return "red-running";
    if (cursor.status === "red-proved") return "green-running";
  }
  if (cursor.targetType === "domain-review" || cursor.targetType === "stack-review") {
    return "running";
  }
  throw new Error(`legalStartNextStatus called with unsupported cursor status ${cursor.status}`);
}

function phaseForStatus(status: UltraPlanCursor["status"], fallback: UltraPlanCursor["phase"]): UltraPlanCursor["phase"] {
  switch (status) {
    case "red-running":
      return "red";
    case "green-running":
      return "green";
    case "red-proved":
      return "green";
    case "green-proved":
      return "complete";
    case "running":
      return "review";
    default:
      return fallback;
  }
}

function provedStatusForPhase(phase: UltraPlanProofCandidate["phase"]): UltraPlanScenarioStatus | null {
  if (phase === "red") return "red-proved";
  if (phase === "green") return "green-proved";
  return null;
}

function advancedCursor(cursor: UltraPlanCursor, nextStatus: UltraPlanScenarioStatus): UltraPlanCursor {
  return { ...cursor, status: nextStatus, phase: phaseForStatus(nextStatus, cursor.phase) };
}

function pickProofForCursor(proofs: UltraPlanProofCandidate[], cursor: UltraPlanCursor): UltraPlanProofCandidate | null {
  const expectedPhase = inferPhase(cursor);
  for (const proof of proofs) {
    if (proof.phase !== expectedPhase) continue;
    if (proof.target.stack !== cursor.stack) continue;
    if (proof.target.domainId !== cursor.domainId) continue;
    if (proof.target.level !== cursor.level) continue;
    if (proof.target.scenarioId !== cursor.scenarioId) continue;
    return proof;
  }
  return null;
}

function inferPhase(cursor: UltraPlanCursor | null): UltraPlanCursor["phase"] {
  if (!cursor) return "red";
  if (cursor.status === "red-running") return "red";
  if (cursor.status === "green-running") return "green";
  return cursor.phase;
}

function toAffected(cursor: UltraPlanCursor) {
  return {
    stack: cursor.stack,
    domainId: cursor.domainId,
    level: cursor.level,
    scenarioId: cursor.scenarioId,
  };
}
