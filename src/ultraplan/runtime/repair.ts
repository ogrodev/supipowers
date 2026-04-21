import type {
  UltraPlanAttemptRecord,
  UltraPlanBlocker,
  UltraPlanManifest,
  UltraPlanRepairAction,
  UltraPlanRuntimeTracker,
} from "../../types.js";
import { buildUnsafeRepairRequiredBlocker } from "./blockers.js";

/**
 * Slice-2 deterministic repair engine. Pure.
 *
 * Safe auto-repair categories (spec §safe auto-repair boundaries, lines 707–723):
 * - recompute cursor
 * - recompute progress summaries
 * - clear impossible active-attempt references
 * - convert orphaned in-flight attempts into interrupted state
 * - clear blockers directly invalidated by later proof on the same target
 *
 * Forbidden: inventing proof, promoting a target to terminal without evidence, discarding
 * conflicting evidence, skipping ahead, or rewriting authored intent. When repair would require
 * any of those, the engine emits an `unsafe-repair-required` blocker instead of a mutation.
 */

export interface RepairState {
  tracker: UltraPlanRuntimeTracker;
  manifest: UltraPlanManifest | null;
}

export interface RepairPlan {
  /** Deterministic actions the caller applies to the tracker / derived state. */
  actions: UltraPlanRepairAction[];
  /** Blockers emitted by the repair engine when deterministic recovery is unsafe. */
  emittedBlockers: UltraPlanBlocker[];
  /** What the caller should do with the tracker's `activeAttempt`. */
  activeAttemptAction: "leave" | "clear" | "finalize-as-interrupted";
}

// ---------------------------------------------------------------------------
// session_start
// ---------------------------------------------------------------------------

export function repairOnSessionStart(state: RepairState, nowIso: string): RepairPlan {
  const actions: UltraPlanRepairAction[] = [];
  const emittedBlockers: UltraPlanBlocker[] = [];
  let activeAttemptAction: RepairPlan["activeAttemptAction"] = "leave";

  const active = state.tracker.activeAttempt;
  if (active) {
    const hasProof = active.proofCandidates.length > 0;
    const hasBlocker = active.blockerCandidates.length > 0;

    if (hasProof && hasBlocker) {
      // Conflicting evidence is not safe to auto-repair. Fail closed: emit a blocker, still
      // convert the attempt to interrupted so the reducer sees a clean ledger on next finalize.
      emittedBlockers.push(buildUnsafeRepairRequiredBlocker({
        detectedAt: nowIso,
        scope: "scenario",
        affected: {
          stack: active.cursorSnapshot?.stack ?? null,
          domainId: active.cursorSnapshot?.domainId ?? null,
          level: active.cursorSnapshot?.level ?? null,
          scenarioId: active.cursorSnapshot?.scenarioId ?? null,
        },
        reason: `attempt ${active.attemptId} carries both proof and blocker candidates; cannot auto-finalize`,
      }));
      actions.push({
        op: "convert-active-to-interrupted",
        attemptId: active.attemptId,
        reason: "conflicting proof+blocker on resume",
      });
      activeAttemptAction = "finalize-as-interrupted";
    } else {
      // Orphaned in-flight attempt: no committed outcome, no conflicting evidence. Convert to
      // interrupted — this is explicitly allowed (spec §safe auto-repair).
      actions.push({
        op: "convert-active-to-interrupted",
        attemptId: active.attemptId,
        reason: "orphaned in-flight attempt recovered on session_start",
      });
      activeAttemptAction = "finalize-as-interrupted";
    }
  }

  // Blocker clearing: clear only when a later proof on the same target exists.
  const manifestBlocker = state.manifest?.blocker ?? null;
  if (manifestBlocker) {
    const clearedBy = findLaterProofForBlocker(state.tracker, manifestBlocker);
    if (clearedBy) {
      actions.push({
        op: "clear-blocker",
        scope: manifestBlocker.scope,
        clearedByObservationFingerprint: clearedBy,
      });
    }
  }

  return { actions, emittedBlockers, activeAttemptAction };
}

// ---------------------------------------------------------------------------
// session_shutdown
// ---------------------------------------------------------------------------

export function repairOnSessionShutdown(state: RepairState, nowIso: string): RepairPlan {
  const actions: UltraPlanRepairAction[] = [];
  let activeAttemptAction: RepairPlan["activeAttemptAction"] = "leave";

  const active = state.tracker.activeAttempt;
  if (active) {
    actions.push({
      op: "convert-active-to-interrupted",
      attemptId: active.attemptId,
      reason: `session shutdown with in-flight attempt (recorded at ${nowIso})`,
    });
    activeAttemptAction = "finalize-as-interrupted";
  }

  return { actions, emittedBlockers: [], activeAttemptAction };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function findLaterProofForBlocker(tracker: UltraPlanRuntimeTracker, blocker: UltraPlanBlocker): string | null {
  const affected = blocker.affected;
  for (const attempt of tracker.finalizedAttempts) {
    if (attempt.outcome !== "advanced") continue;
    const proof = attempt.proofCandidates.find((p) =>
      p.target.stack === affected.stack
      && p.target.domainId === affected.domainId
      && p.target.level === affected.level
      && p.target.scenarioId === affected.scenarioId,
    );
    if (proof && isLaterThan(attempt.finalizedAt, blocker.detectedAt)) {
      return proof.observationFingerprint;
    }
  }
  return null;
}

function isLaterThan(candidate: string | null, reference: string): boolean {
  if (!candidate) return false;
  const a = Date.parse(candidate);
  const b = Date.parse(reference);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  return a > b;
}
