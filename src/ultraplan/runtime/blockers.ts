import type {
  UltraPlanAffectedUnitRef,
  UltraPlanBlocker,
  UltraPlanBlockerScope,
  UltraPlanExecutionPhase,
  UltraPlanRuntimeBlockerCode,
} from "../../types.js";

/**
 * Slice-2 structured blocker factories.
 *
 * The reducer, repair engine, and migration engine only ever emit blockers by calling these
 * factories so every runtime blocker has the same invariants: correct code, truthful recovery
 * mode, non-empty nextAction, and audit-ready structured details.
 *
 * Defaults follow the approved runtime spec §failure policy and §structured blockers and the
 * delta spec's migration failure classes.
 */

interface BaseArgs {
  detectedAt: string;
  scope?: UltraPlanBlockerScope;
  affected?: UltraPlanAffectedUnitRef;
}

function requireDetectedAt(args: BaseArgs): string {
  if (!args.detectedAt || args.detectedAt.trim().length === 0) {
    throw new Error("blocker factory: detectedAt is required");
  }
  return args.detectedAt;
}

function ensureAffected(args: BaseArgs): UltraPlanAffectedUnitRef {
  return args.affected ?? { stack: null, domainId: null, level: null, scenarioId: null };
}

function buildBlocker(
  code: UltraPlanRuntimeBlockerCode,
  args: BaseArgs,
  spec: {
    scope: UltraPlanBlockerScope;
    message: string;
    nextAction: string;
    recoveryMode: UltraPlanBlocker["recoveryMode"];
    retryable: boolean;
    recoverable?: boolean;
    details?: Record<string, unknown>;
  },
): UltraPlanBlocker {
  return {
    code,
    message: spec.message,
    scope: args.scope ?? spec.scope,
    affected: ensureAffected(args),
    recoverable: spec.recoverable ?? true,
    recoveryMode: spec.recoveryMode,
    nextAction: spec.nextAction,
    retryable: spec.retryable,
    detectedAt: requireDetectedAt(args),
    ...(spec.details ? { details: spec.details } : {}),
  };
}

// ---------------------------------------------------------------------------
// Correlation ambiguity
// ---------------------------------------------------------------------------

export interface CorrelationAmbiguousArgs extends BaseArgs {
  reason: string;
}

export function buildCorrelationAmbiguousBlocker(args: CorrelationAmbiguousArgs): UltraPlanBlocker {
  return buildBlocker("correlation-ambiguous", args, {
    scope: "session",
    message: `UltraPlan correlation is ambiguous: ${args.reason}`,
    nextAction: "Inspect the normalized hook trail and identify which attempt the event belongs to, then resume manually.",
    recoveryMode: "manual",
    retryable: false,
    details: { reason: args.reason },
  });
}

// ---------------------------------------------------------------------------
// Proof failures
// ---------------------------------------------------------------------------

export interface ProofMissingArgs extends BaseArgs {
  expectedPhase: UltraPlanExecutionPhase;
}

export function buildProofMissingBlocker(args: ProofMissingArgs): UltraPlanBlocker {
  return buildBlocker("proof-missing", args, {
    scope: "scenario",
    message: `Expected ${args.expectedPhase}-phase proof but none was observed.`,
    nextAction: `Re-run the ${args.expectedPhase}-phase step and capture proof before finalization.`,
    recoveryMode: "retry",
    retryable: true,
    details: { expectedPhase: args.expectedPhase },
  });
}

export interface ProofInvalidArgs extends BaseArgs {
  reason: string;
}

export function buildProofInvalidBlocker(args: ProofInvalidArgs): UltraPlanBlocker {
  return buildBlocker("proof-invalid", args, {
    scope: "scenario",
    message: `Proof artifact was present but invalid: ${args.reason}`,
    nextAction: "Regenerate proof with the required phase/target match and retry.",
    recoveryMode: "retry",
    retryable: true,
    details: { reason: args.reason },
  });
}

// ---------------------------------------------------------------------------
// Conflicting evidence (fail closed)
// ---------------------------------------------------------------------------

export interface ConflictingEvidenceArgs extends BaseArgs {
  reason: string;
}

export function buildConflictingEvidenceBlocker(args: ConflictingEvidenceArgs): UltraPlanBlocker {
  return buildBlocker("conflicting-evidence", args, {
    scope: "scenario",
    message: `Conflicting evidence observed: ${args.reason}`,
    nextAction: "Resolve the conflict manually: either discard the contradicting evidence or fix the upstream source, then rerun.",
    recoveryMode: "manual",
    retryable: false,
    details: { reason: args.reason },
  });
}

// ---------------------------------------------------------------------------
// Interrupted attempt
// ---------------------------------------------------------------------------

export interface InterruptedAttemptArgs extends BaseArgs {
  attemptId: string;
  reason?: string;
}

export function buildInterruptedAttemptBlocker(args: InterruptedAttemptArgs): UltraPlanBlocker {
  return buildBlocker("interrupted-attempt", args, {
    scope: "scenario",
    message: args.reason
      ? `Attempt ${args.attemptId} was interrupted: ${args.reason}`
      : `Attempt ${args.attemptId} was interrupted before finalization.`,
    nextAction: "Retry the attempt with a fresh launch; do not reuse the interrupted attempt id.",
    recoveryMode: "retry",
    retryable: true,
    details: {
      attemptId: args.attemptId,
      ...(args.reason ? { reason: args.reason } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Persistence failure
// ---------------------------------------------------------------------------

export interface PersistenceFailureArgs extends BaseArgs {
  reason: string;
}

export function buildPersistenceFailureBlocker(args: PersistenceFailureArgs): UltraPlanBlocker {
  return buildBlocker("persistence-failure", args, {
    scope: "session",
    message: `UltraPlan persistence failure: ${args.reason}`,
    nextAction: "Inspect runtime-tracker.json, manifest.json, and hooks-log.jsonl for partial writes and recover manually before resuming.",
    recoveryMode: "manual",
    retryable: false,
    details: { reason: args.reason },
  });
}

// ---------------------------------------------------------------------------
// Unsafe repair required
// ---------------------------------------------------------------------------

export interface UnsafeRepairRequiredArgs extends BaseArgs {
  reason: string;
}

export function buildUnsafeRepairRequiredBlocker(args: UnsafeRepairRequiredArgs): UltraPlanBlocker {
  return buildBlocker("unsafe-repair-required", args, {
    scope: "session",
    message: `Deterministic repair is unsafe: ${args.reason}`,
    nextAction: "Manually reconcile tracker, manifest, and authored state. Do not advance any scenario until the ambiguity is resolved.",
    recoveryMode: "manual",
    retryable: false,
    details: { reason: args.reason },
  });
}

// ---------------------------------------------------------------------------
// Migration failures (delta spec §fail-closed rule)
// ---------------------------------------------------------------------------

export interface MigrationUnsafeArgs extends BaseArgs {
  legacyPath: string;
  reason: string;
  interruptedPath?: string;
}

export function buildMigrationUnsafeBlocker(args: MigrationUnsafeArgs): UltraPlanBlocker {
  return buildBlocker("migration-unsafe", args, {
    scope: "session",
    message: `UltraPlan migration cannot complete safely: ${args.reason}`,
    nextAction: `Inspect ${args.legacyPath}${args.interruptedPath ? ` and ${args.interruptedPath}` : ""} and resolve the inconsistency manually before retrying.`,
    recoveryMode: "manual",
    retryable: false,
    details: {
      legacyPath: args.legacyPath,
      ...(args.interruptedPath ? { interruptedPath: args.interruptedPath } : {}),
      reason: args.reason,
    },
  });
}

export interface MigrationConflictArgs extends BaseArgs {
  legacyPath: string;
  globalPath: string;
  reason: string;
}

export function buildMigrationConflictBlocker(args: MigrationConflictArgs): UltraPlanBlocker {
  return buildBlocker("migration-conflict", args, {
    scope: "session",
    message: `UltraPlan migration conflict: ${args.reason}`,
    nextAction: `Decide which of ${args.legacyPath} or ${args.globalPath} is canonical, reconcile the other, and retry.`,
    recoveryMode: "manual",
    retryable: false,
    details: {
      legacyPath: args.legacyPath,
      globalPath: args.globalPath,
      reason: args.reason,
    },
  });
}
