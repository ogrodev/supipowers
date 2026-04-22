import type { Platform } from "../../platform/types.js";
import type {
  UltraPlanCursor,
  UltraPlanHookEventName,
  UltraPlanHookObservation,
  UltraPlanLaunchContext,
  UltraPlanMutationPlan,
  UltraPlanRuntimeTracker,
  UltraPlanStorageResult,
} from "../../types.js";
import { LAUNCH_CONTEXT_METADATA_KEY, recoverLaunchContextFromEvent } from "./launch-context.js";
import { normalizeHookEvent, type NormalizeHookEventInput } from "./normalize.js";
import {
  loadTracker as loadTrackerDefault,
  saveTrackerAtomic as saveTrackerAtomicDefault,
} from "./tracker-storage.js";
import { reduce as reduceDefault, type ReducerState } from "./reducer.js";
import {
  repairOnSessionShutdown as repairOnSessionShutdownDefault,
  repairOnSessionStart as repairOnSessionStartDefault,
  type RepairPlan,
} from "./repair.js";
import {
  resolveSessionMigration as resolveSessionMigrationDefault,
  type MigrationOutcome,
} from "./migration.js";
import { readActiveUltraPlanExecution } from "./active-execution.js";
import { applyUltraPlanMutation } from "./apply-mutation.js";

/**
 * Slice-2 hook bridge.
 *
 * This is the only UltraPlan module that `src/context-mode/hooks.ts` imports. It wires platform
 * hook events into the runtime pipeline (normalize \u2192 reduce \u2192 apply) without performing any
 * business decisions itself. Every runtime unit is injected so the bridge is fully testable in
 * isolation and so the context-mode hook layer stays generic.
 */

export interface UltraPlanSessionContext {
  sessionId: string;
  cwd: string;
}

export interface UltraPlanHookBridgeDeps {
  /** Resolves the currently-focused UltraPlan session for a given platform hook context. */
  resolveActiveSession(ctx: unknown): UltraPlanSessionContext | null;

  normalize(input: NormalizeHookEventInput): UltraPlanHookObservation;

  loadTracker(paths: Platform["paths"], cwd: string, sessionId: string): UltraPlanStorageResult<UltraPlanRuntimeTracker>;
  saveTrackerAtomic(
    paths: Platform["paths"],
    cwd: string,
    sessionId: string,
    tracker: UltraPlanRuntimeTracker,
  ): UltraPlanStorageResult<string>;

  reduce(state: ReducerState, action: Parameters<typeof reduceDefault>[1]): UltraPlanMutationPlan;

  /** Single I/O funnel that applies a mutation plan in the required durability order. */
  applyMutationPlan(input: ApplyMutationPlanInput): void;

  repairOnSessionStart(state: { tracker: UltraPlanRuntimeTracker; manifest: null }, nowIso: string): RepairPlan;
  repairOnSessionShutdown(state: { tracker: UltraPlanRuntimeTracker; manifest: null }, nowIso: string): RepairPlan;

  resolveSessionMigration(input: {
    paths: Platform["paths"];
    cwd: string;
    sessionId: string;
    nowIso: string;
  }): MigrationOutcome;
}

export interface ApplyMutationPlanInput {
  platform: Platform;
  cwd: string;
  sessionId: string;
  observation: UltraPlanHookObservation;
  mutationPlan: UltraPlanMutationPlan;
}

/**
 * Register the UltraPlan hook bridge on a platform. The six UltraPlan-relevant hooks are wired to
 * the runtime pipeline; when `resolveActiveSession` returns null the handlers are no-ops.
 */
export function registerUltraPlanHookBridge(
  platform: Platform,
  overrides: Partial<UltraPlanHookBridgeDeps> = {},
): void {
  const deps: UltraPlanHookBridgeDeps = {
    resolveActiveSession: overrides.resolveActiveSession ?? defaultResolveActiveSession,
    normalize: overrides.normalize ?? normalizeHookEvent,
    loadTracker: overrides.loadTracker ?? loadTrackerDefault,
    saveTrackerAtomic: overrides.saveTrackerAtomic ?? saveTrackerAtomicDefault,
    reduce: overrides.reduce ?? reduceDefault,
    applyMutationPlan: overrides.applyMutationPlan ?? applyMutationPlanDefault,
    repairOnSessionStart: overrides.repairOnSessionStart ?? repairOnSessionStartDefault,
    repairOnSessionShutdown: overrides.repairOnSessionShutdown ?? repairOnSessionShutdownDefault,
    resolveSessionMigration: overrides.resolveSessionMigration ?? resolveSessionMigrationDefault,
  };

  const sessionStart = (rawEvent: unknown, ctx?: unknown) =>
    handleSessionStart(platform, deps, rawEvent, ctx);
  const beforeAgentStart = (rawEvent: unknown, ctx?: unknown) =>
    handleAttemptEvent(platform, deps, "before_agent_start", rawEvent, ctx);
  const toolCall = (rawEvent: unknown, ctx?: unknown) =>
    handleAttemptEvent(platform, deps, "tool_call", rawEvent, ctx);
  const toolResult = (rawEvent: unknown, ctx?: unknown) =>
    handleAttemptEvent(platform, deps, "tool_result", rawEvent, ctx);
  const agentEnd = (rawEvent: unknown, ctx?: unknown) =>
    handleAttemptEvent(platform, deps, "agent_end", rawEvent, ctx);
  const sessionShutdown = (rawEvent: unknown, ctx?: unknown) =>
    handleSessionShutdown(platform, deps, rawEvent, ctx);

  platform.on("session_start", sessionStart);
  platform.on("before_agent_start", beforeAgentStart);
  platform.on("tool_call", toolCall);
  platform.on("tool_result", toolResult);
  platform.on("agent_end", agentEnd);
  platform.on("session_shutdown", sessionShutdown);
}

// ---------------------------------------------------------------------------
// Hook handlers
// ---------------------------------------------------------------------------

function handleSessionStart(
  platform: Platform,
  deps: UltraPlanHookBridgeDeps,
  rawEvent: unknown,
  ctx: unknown,
): void {
  const session = resolveSessionContext(deps, platform, "session_start", rawEvent, ctx);
  if (!session) return;

  const nowIso = new Date().toISOString();

  // Migration check runs before any tracker work so a partial global directory can be repaired.
  deps.resolveSessionMigration({ paths: platform.paths, cwd: session.cwd, sessionId: session.sessionId, nowIso });

  const tracker = loadTrackerOrEmpty(deps, platform, session);
  const repair = deps.repairOnSessionStart({ tracker, manifest: null }, nowIso);
  void repair; // Slice-2 bridge applies repair actions inside the reducer flow below.


  const observation = deps.normalize({
    hookEvent: "session_start",
    sessionId: session.sessionId,
    nowIso,
    metadata: extractMetadata(rawEvent, ctx),
    prompt: extractPrompt(rawEvent, ctx),
    persistedActiveAttempt: tracker.activeAttempt,
    payload: toRecord(rawEvent),
  });

  const plan = deps.reduce({ tracker, cursor: tracker.activeAttempt?.cursorSnapshot ?? null }, {
    kind: "session_started",
    observation,
    nowIso,
  });
  deps.applyMutationPlan({ platform, cwd: session.cwd, sessionId: session.sessionId, observation, mutationPlan: plan });
}

function handleAttemptEvent(
  platform: Platform,
  deps: UltraPlanHookBridgeDeps,
  hookEvent: UltraPlanHookEventName,
  rawEvent: unknown,
  ctx: unknown,
): void {
  const session = resolveSessionContext(deps, platform, hookEvent, rawEvent, ctx);
  if (!session) return;

  const nowIso = new Date().toISOString();
  const tracker = loadTrackerOrEmpty(deps, platform, session);
  const activeExecution = readActiveUltraPlanExecutionForSession(session);
  const observation = deps.normalize({
    hookEvent,
    sessionId: session.sessionId,
    nowIso,
    metadata: extractMetadata(rawEvent, ctx),
    prompt: extractPrompt(rawEvent, ctx),
    persistedActiveAttempt: tracker.activeAttempt,
    payload: extractPayload(rawEvent),
    targetHint: extractTargetHint(rawEvent, ctx),
    fallbackTargetHint: buildFallbackTargetHint(activeExecution),
  });

  const cursor: UltraPlanCursor | null = tracker.activeAttempt?.cursorSnapshot ?? null;

  const plan = deps.reduce({ tracker, cursor }, reducerActionForEvent(hookEvent, observation, nowIso));
  deps.applyMutationPlan({ platform, cwd: session.cwd, sessionId: session.sessionId, observation, mutationPlan: plan });
}

function handleSessionShutdown(
  platform: Platform,
  deps: UltraPlanHookBridgeDeps,
  rawEvent: unknown,
  ctx: unknown,
): void {
  const session = resolveSessionContext(deps, platform, "session_shutdown", rawEvent, ctx);
  if (!session) return;

  const nowIso = new Date().toISOString();
  const tracker = loadTrackerOrEmpty(deps, platform, session);
  const repair = deps.repairOnSessionShutdown({ tracker, manifest: null }, nowIso);
  void repair; // passed into the reducer via repair_applied actions in Slice-5 expansion.


  const observation = deps.normalize({
    hookEvent: "session_shutdown",
    sessionId: session.sessionId,
    nowIso,
    metadata: extractMetadata(rawEvent, ctx),
    prompt: extractPrompt(rawEvent, ctx),
    persistedActiveAttempt: tracker.activeAttempt,
    payload: toRecord(rawEvent),
  });

  const plan = deps.reduce({ tracker, cursor: tracker.activeAttempt?.cursorSnapshot ?? null }, {
    kind: "session_shutdown",
    observation,
    nowIso,
  });
  deps.applyMutationPlan({ platform, cwd: session.cwd, sessionId: session.sessionId, observation, mutationPlan: plan });
}

// ---------------------------------------------------------------------------
// Default resolvers
// ---------------------------------------------------------------------------

function defaultResolveActiveSession(_ctx: unknown): UltraPlanSessionContext | null {
  return null;
}

function applyMutationPlanDefault(input: ApplyMutationPlanInput): void {
  applyUltraPlanMutation(input);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadTrackerOrEmpty(
  deps: UltraPlanHookBridgeDeps,
  platform: Platform,
  session: UltraPlanSessionContext,
): UltraPlanRuntimeTracker {
  const result = deps.loadTracker(platform.paths, session.cwd, session.sessionId);
  if (result.ok) return result.value;
  return {
    version: 1,
    sessionId: session.sessionId,
    activeAttempt: null,
    finalizedAttempts: [],
    appliedFingerprints: [],
    pendingMutation: null,
    updatedAt: new Date().toISOString(),
  };
}

function resolveSessionContext(
  deps: UltraPlanHookBridgeDeps,
  platform: Platform,
  hookEvent: UltraPlanHookEventName,
  rawEvent: unknown,
  ctx: unknown,
): UltraPlanSessionContext | null {
  const explicit = deps.resolveActiveSession(ctx);
  if (explicit) {
    return explicit;
  }

  return resolveFallbackSessionContext(deps, platform, hookEvent, rawEvent, ctx);
}

function resolveFallbackSessionContext(
  deps: UltraPlanHookBridgeDeps,
  platform: Platform,
  hookEvent: UltraPlanHookEventName,
  rawEvent: unknown,
  ctx: unknown,
): UltraPlanSessionContext | null {
  const activeExecution = readActiveUltraPlanExecution();
  if (!activeExecution || hookEvent === "session_start") {
    return null;
  }

  const launchContext = recoverLaunchContextFromEvent({
    metadata: extractMetadata(rawEvent, ctx),
    prompt: extractPrompt(rawEvent, ctx),
    persistedActiveAttempt: null,
  });
  if (launchContext && sameLaunchContext(launchContext, activeExecution.launchContext)) {
    return { sessionId: activeExecution.sessionId, cwd: activeExecution.cwd };
  }

  if (hookEvent === "before_agent_start") {
    return null;
  }

  const tracker = deps.loadTracker(platform.paths, activeExecution.cwd, activeExecution.sessionId);
  if (!tracker.ok || !tracker.value.activeAttempt) {
    return null;
  }

  if (!sameLaunchContext(tracker.value.activeAttempt.launchContext, activeExecution.launchContext)) {
    return null;
  }

  return { sessionId: activeExecution.sessionId, cwd: activeExecution.cwd };
}

function readActiveUltraPlanExecutionForSession(
  session: UltraPlanSessionContext,
 ): ReturnType<typeof readActiveUltraPlanExecution> {
  const activeExecution = readActiveUltraPlanExecution();
  if (!activeExecution) {
    return null;
  }

  if (activeExecution.sessionId !== session.sessionId || activeExecution.cwd !== session.cwd) {
    return null;
  }

  return activeExecution;
}

function sameLaunchContext(left: UltraPlanLaunchContext, right: UltraPlanLaunchContext): boolean {
  return left.attemptId === right.attemptId && left.attemptKey === right.attemptKey;
}

function extractTargetHint(
  rawEvent: unknown,
  ctx: unknown,
): NormalizeHookEventInput["targetHint"] | undefined {
  const rawHint = asRecord(rawEvent)?.targetHint;
  if (rawHint && typeof rawHint === "object" && !Array.isArray(rawHint)) {
    return rawHint as NormalizeHookEventInput["targetHint"];
  }
  const ctxHint = asRecord(ctx)?.targetHint;
  if (ctxHint && typeof ctxHint === "object" && !Array.isArray(ctxHint)) {
    return ctxHint as NormalizeHookEventInput["targetHint"];
  }
  return undefined;
}

function buildFallbackTargetHint(activeExecution: ReturnType<typeof readActiveUltraPlanExecution>): NormalizeHookEventInput["fallbackTargetHint"] {
  if (!activeExecution) {
    return undefined;
  }

  return {
    targetType: activeExecution.target.targetType,
    stack: activeExecution.target.stack,
    domainId: activeExecution.target.domainId,
    level: activeExecution.target.level,
    scenarioId: activeExecution.target.scenarioId,
    phase: activeExecution.target.phase,
    resolvedSlot: activeExecution.target.requiredSlot,
    actorKind: "slot",
    sourceAgent: "sub-agent",
  };
}

function extractPayload(rawEvent: unknown): Record<string, unknown> {
  const payload = toRecord(rawEvent);
  const signalPayload = asRecord(asRecord(rawEvent)?.details)?.payload;
  if (!signalPayload) {
    return payload;
  }

  return {
    ...payload,
    payload: signalPayload,
    summary: typeof payload.summary === "string" ? payload.summary : payload.payloadSummary,
  };
}

function reducerActionForEvent(
  hookEvent: UltraPlanHookEventName,
  observation: UltraPlanHookObservation,
  nowIso: string,
): Parameters<typeof reduceDefault>[1] {
  switch (hookEvent) {
    case "before_agent_start": {
      // The bridge extracts a launch context (or fails correlation at normalization time).
      // When correlation failed, pass an attempt_started action anyway so the reducer emits a
      // blocker plan; the observation's correlationFailure carries the reason.
      const launchContext = {
        attemptId: observation.attemptId ?? "unknown",
        attemptKey: observation.attemptKey ?? "unknown",
        sourceAgent: observation.sourceAgent,
        launchedAt: observation.occurredAt,
      };
      return { kind: "attempt_started", observation, launchContext };
    }
    case "tool_call":
    case "tool_result":
      return { kind: "observation_staged", observation };
    case "agent_end":
      return { kind: "attempt_finalized", observation, nowIso };
    default:
      return { kind: "observation_staged", observation };
  }
}

function extractMetadata(rawEvent: unknown, ctx: unknown): Record<string, unknown> | null {
  const rawMeta = asRecord(rawEvent)?.metadata as Record<string, unknown> | undefined;
  const ctxMeta = asRecord(ctx)?.metadata as Record<string, unknown> | undefined;
  if (rawMeta && ctxMeta) return { ...ctxMeta, ...rawMeta };
  return rawMeta ?? ctxMeta ?? null;
}

function extractPrompt(rawEvent: unknown, ctx: unknown): string | null {
  const rawPrompt = asRecord(rawEvent)?.prompt;
  if (typeof rawPrompt === "string") return rawPrompt;
  const rawSystemPrompt = asRecord(rawEvent)?.systemPrompt;
  if (typeof rawSystemPrompt === "string") return rawSystemPrompt;
  const ctxPrompt = asRecord(ctx)?.prompt;
  if (typeof ctxPrompt === "string") return ctxPrompt;
  return null;
}

function toRecord(value: unknown): Record<string, unknown> {
  return asRecord(value) ?? {};
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

// Re-export useful carrier bits for hosts that need them.
export { LAUNCH_CONTEXT_METADATA_KEY, recoverLaunchContextFromEvent };
