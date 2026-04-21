import { createHash } from "node:crypto";
import type {
  UltraPlanActorKind,
  UltraPlanAttemptRecord,
  UltraPlanCursorTargetType,
  UltraPlanExecutionPhase,
  UltraPlanHookEventName,
  UltraPlanHookObservation,
  UltraPlanObservationTarget,
  UltraPlanScenarioLevel,
  UltraPlanSourceAgent,
  UltraPlanStackId,
} from "../../types.js";
import { recoverLaunchContextFromEvent } from "./launch-context.js";

/**
 * Slice-2 normalization seam.
 *
 * Converts raw platform hook events into typed `UltraPlanHookObservation` values. This module is
 * the gate between raw platform behavior and UltraPlan runtime truth — by the time an observation
 * reaches the reducer, its attempt identity, target, replay fingerprint, and correlation status
 * are all fully resolved. Pure.
 */

export interface UltraPlanTargetHint {
  targetType?: UltraPlanCursorTargetType;
  stack?: UltraPlanStackId | null;
  domainId?: string | null;
  level?: UltraPlanScenarioLevel | null;
  scenarioId?: string | null;
  phase?: UltraPlanExecutionPhase;
  resolvedSlot?: string | null;
  actorKind?: UltraPlanActorKind;
  sourceAgent?: UltraPlanSourceAgent;
}

export interface NormalizeHookEventInput {
  hookEvent: UltraPlanHookEventName;
  sessionId: string;
  nowIso: string;

  /** Structured platform metadata (may carry `ultraplanLaunchContext`). */
  metadata?: Record<string, unknown> | null;
  /** Prompt/assignment/system-prompt text (may carry `ULTRAPLAN_LAUNCH_CONTEXT=<json>`). */
  prompt?: string | null;
  /** The currently-persisted active attempt from the tracker (last-resort carrier). */
  persistedActiveAttempt?: UltraPlanAttemptRecord | null;

  /** Raw platform payload (tool args, results, exit reasons, etc.) — used for audit + fingerprint. */
  payload?: Record<string, unknown>;

  /**
   * Hints about the slot-backed target derived from the platform event (e.g. before_agent_start
   * args). When absent or the hook is a pure session event, the observation is classified as
   * session-scope.
   */
  targetHint?: UltraPlanTargetHint;

  /** Optional platform-native event id (tool call id, turn id, agent run id). */
  nativeEventId?: string | null;
  /** Optional causation id grouping related hook activity. */
  causationId?: string | null;
  /** Optional override for when the event actually occurred; defaults to `nowIso`. */
  occurredAt?: string;
}

/**
 * Hook events that are session-scope regardless of target hint. Main-orchestrator-only
 * before_agent_start / tool_call / tool_result / agent_end events that arrive with no slot-backed
 * target hint are also treated as session-scope via the classification logic below.
 */
const SESSION_SCOPE_HOOKS: readonly UltraPlanHookEventName[] = [
  "session_start",
  "session_shutdown",
];

export function normalizeHookEvent(input: NormalizeHookEventInput): UltraPlanHookObservation {
  const occurredAt = input.occurredAt ?? input.nowIso;
  const { actorKind, isSessionScope } = classifyActor(input);
  const sourceAgent = input.targetHint?.sourceAgent
    ?? (isSessionScope ? "main" : "sub-agent");

  // Session-scope observations carry no attempt identity and no target.
  if (isSessionScope) {
    return {
      sessionId: input.sessionId,
      hookEvent: input.hookEvent,
      actorKind: "main-orchestrator",
      attemptId: null,
      attemptKey: null,
      sourceAgent,
      occurredAt,
      causationId: input.causationId ?? null,
      fingerprint: computeFingerprint({
        attemptId: null,
        hookEvent: input.hookEvent,
        nativeEventId: input.nativeEventId ?? null,
        payload: input.payload ?? {},
      }),
      target: null,
      correlationFailure: null,
      payloadSummary: summarizePayload(input.hookEvent, input.payload),
    };
  }

  // Slot-backed observation: require a launch context carrier for correlation.
  const launchContext = recoverLaunchContextFromEvent({
    metadata: input.metadata ?? null,
    prompt: input.prompt ?? null,
    persistedActiveAttempt: input.persistedActiveAttempt ?? null,
  });

  if (!launchContext) {
    return {
      sessionId: input.sessionId,
      hookEvent: input.hookEvent,
      actorKind,
      attemptId: null,
      attemptKey: null,
      sourceAgent,
      occurredAt,
      causationId: input.causationId ?? null,
      // Fingerprint a failed-correlation observation off its native id + payload so replay still
      // dedupes the failure record rather than appending a new blocker every time.
      fingerprint: computeFingerprint({
        attemptId: null,
        hookEvent: input.hookEvent,
        nativeEventId: input.nativeEventId ?? null,
        payload: input.payload ?? {},
      }),
      target: buildTargetFromHint(input.targetHint),
      correlationFailure: {
        reason: "slot-backed hook event without a resolvable UltraPlan launch context",
      },
      payloadSummary: summarizePayload(input.hookEvent, input.payload),
    };
  }

  return {
    sessionId: input.sessionId,
    hookEvent: input.hookEvent,
    actorKind,
    attemptId: launchContext.attemptId,
    attemptKey: launchContext.attemptKey,
    sourceAgent,
    occurredAt,
    causationId: input.causationId ?? null,
    fingerprint: computeFingerprint({
      attemptId: launchContext.attemptId,
      hookEvent: input.hookEvent,
      nativeEventId: input.nativeEventId ?? null,
      payload: input.payload ?? {},
    }),
    target: buildTargetFromHint(input.targetHint),
    correlationFailure: null,
    payloadSummary: summarizePayload(input.hookEvent, input.payload),
  };
}

// --- helpers ---------------------------------------------------------------

function classifyActor(
  input: NormalizeHookEventInput,
): { actorKind: UltraPlanActorKind; isSessionScope: boolean } {
  if (SESSION_SCOPE_HOOKS.includes(input.hookEvent)) {
    return { actorKind: "main-orchestrator", isSessionScope: true };
  }
  // Hint-driven classification. When a hint is absent, an attempt-shaped hook (before_agent_start
  // / tool_call / tool_result / agent_end) without slot context is treated as session-scope.
  const hint = input.targetHint;
  if (!hint) {
    return { actorKind: "main-orchestrator", isSessionScope: true };
  }
  if (hint.actorKind === "main-orchestrator") {
    return { actorKind: "main-orchestrator", isSessionScope: true };
  }
  // Slot-backed work: the attempt must correlate to a launch context.
  return { actorKind: hint.actorKind ?? "slot", isSessionScope: false };
}

function buildTargetFromHint(hint: UltraPlanTargetHint | undefined): UltraPlanObservationTarget | null {
  if (!hint) return null;
  const hasAnyField = hint.targetType !== undefined
    || hint.stack !== undefined
    || hint.domainId !== undefined
    || hint.level !== undefined
    || hint.scenarioId !== undefined
    || hint.phase !== undefined
    || hint.resolvedSlot !== undefined;
  if (!hasAnyField) return null;
  return {
    targetType: hint.targetType ?? "scenario",
    stack: hint.stack ?? null,
    domainId: hint.domainId ?? null,
    level: hint.level ?? null,
    scenarioId: hint.scenarioId ?? null,
    phase: hint.phase ?? "red",
    resolvedSlot: hint.resolvedSlot ?? null,
  };
}

interface FingerprintComponents {
  attemptId: string | null;
  hookEvent: UltraPlanHookEventName;
  nativeEventId: string | null;
  payload: unknown;
}

/**
 * Replay fingerprint per spec §cross-hook carrier line 459:
 *   `attemptId + hook name + native event id + normalized payload`
 *
 * The payload is canonicalized (sorted keys) so equivalent payloads with different key ordering
 * produce the same fingerprint. This is what makes replay dedupe durable across reloads.
 */
function computeFingerprint(parts: FingerprintComponents): string {
  const canonical = JSON.stringify({
    attemptId: parts.attemptId,
    hookEvent: parts.hookEvent,
    nativeEventId: parts.nativeEventId,
    payload: canonicalize(parts.payload),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, canonicalize(v)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

function summarizePayload(hookEvent: UltraPlanHookEventName, payload: Record<string, unknown> | undefined): string {
  if (!payload) return hookEvent;
  const tool = typeof payload.toolName === "string" ? payload.toolName : undefined;
  const exit = typeof payload.exitCode === "number" ? payload.exitCode : undefined;
  const reason = typeof payload.exitReason === "string" ? payload.exitReason : undefined;
  const summary = typeof payload.summary === "string" ? payload.summary : undefined;
  const bits: string[] = [hookEvent];
  if (tool) bits.push(`tool=${tool}`);
  if (exit !== undefined) bits.push(`exit=${exit}`);
  if (reason) bits.push(`reason=${reason}`);
  if (summary) bits.push(summary);
  return bits.join(" ");
}
