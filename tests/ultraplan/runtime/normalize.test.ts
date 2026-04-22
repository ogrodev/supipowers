import { describe, expect, test } from "bun:test";
import type {
  UltraPlanAttemptRecord,
  UltraPlanHookObservation,
  UltraPlanLaunchContext,
} from "../../../src/types.js";
import { isUltraPlanHookObservation } from "../../../src/ultraplan/contracts.js";
import {
  injectLaunchContextIntoPrompt,
  injectTargetHintIntoPrompt,
  LAUNCH_CONTEXT_METADATA_KEY,
  mintLaunchContext,
} from "../../../src/ultraplan/runtime/launch-context.js";
import { normalizeHookEvent } from "../../../src/ultraplan/runtime/normalize.js";

function mkActive(lc: UltraPlanLaunchContext): UltraPlanAttemptRecord {
  return {
    attemptId: lc.attemptId,
    attemptKey: lc.attemptKey,
    launchContext: lc,
    cursorSnapshot: null,
    observations: [],
    proofCandidates: [],
    blockerCandidates: [],
    outcome: null,
    startedAt: lc.launchedAt,
    finalizedAt: null,
  };
}

const BASE_TARGET = {
  targetType: "scenario" as const,
  stack: "frontend" as const,
  domainId: "auth",
  level: "unit" as const,
  scenarioId: "scenario-login-form-renders",
  phase: "red" as const,
  resolvedSlot: "frontend-tester",
  actorKind: "slot" as const,
  sourceAgent: "sub-agent" as const,
};

describe("normalizeHookEvent", () => {
  test("normalizes a slot-backed tool_result with metadata-carried launch context", () => {
    const lc = mintLaunchContext({
      attemptKey: "frontend/auth/unit/scenario-login-form-renders/red",
      sourceAgent: "sub-agent",
      nowIso: "2026-04-19T12:00:00.000Z",
    });
    const obs = normalizeHookEvent({
      hookEvent: "tool_result",
      sessionId: "up-123",
      nowIso: "2026-04-19T12:00:01.000Z",
      metadata: { [LAUNCH_CONTEXT_METADATA_KEY]: lc },
      prompt: null,
      persistedActiveAttempt: null,
      payload: { toolName: "bash", exitCode: 1, stdout: "failing as expected" },
      nativeEventId: "tool-call-1",
      causationId: "turn-42",
      targetHint: BASE_TARGET,
    });

    expect(isUltraPlanHookObservation(obs)).toBe(true);
    expect(obs.attemptId).toBe(lc.attemptId);
    expect(obs.attemptKey).toBe(lc.attemptKey);
    expect(obs.actorKind).toBe("slot");
    expect(obs.sourceAgent).toBe("sub-agent");
    expect(obs.target?.scenarioId).toBe(BASE_TARGET.scenarioId);
    expect(obs.correlationFailure).toBeNull();
    expect(obs.fingerprint.length).toBeGreaterThan(0);
  });

  test("classifies session_start / session_shutdown as session-scope (not attempt-keyed)", () => {
    const start = normalizeHookEvent({
      hookEvent: "session_start",
      sessionId: "up-123",
      nowIso: "2026-04-19T12:00:00.000Z",
      metadata: null,
      prompt: null,
      persistedActiveAttempt: null,
      payload: {},
    });
    expect(start.actorKind).toBe("main-orchestrator");
    expect(start.attemptId).toBeNull();
    expect(start.attemptKey).toBeNull();
    expect(start.target).toBeNull();
    expect(start.correlationFailure).toBeNull();

    const shutdown = normalizeHookEvent({
      hookEvent: "session_shutdown",
      sessionId: "up-123",
      nowIso: "2026-04-19T13:00:00.000Z",
      metadata: null,
      prompt: null,
      persistedActiveAttempt: null,
      payload: {},
    });
    expect(shutdown.actorKind).toBe("main-orchestrator");
    expect(shutdown.attemptId).toBeNull();
  });

  test("classifies main-orchestrator before_agent_start (no slot-backed target) as session-scope", () => {
    const obs = normalizeHookEvent({
      hookEvent: "before_agent_start",
      sessionId: "up-123",
      nowIso: "2026-04-19T12:00:00.000Z",
      metadata: null,
      prompt: null,
      persistedActiveAttempt: null,
      payload: { role: "main" },
      targetHint: { actorKind: "main-orchestrator", sourceAgent: "main" },
    });
    expect(obs.actorKind).toBe("main-orchestrator");
    expect(obs.attemptId).toBeNull();
    expect(obs.correlationFailure).toBeNull();
  });

  test("slot-backed event without any launch-context carrier returns a correlation-failure observation", () => {
    const obs = normalizeHookEvent({
      hookEvent: "tool_result",
      sessionId: "up-123",
      nowIso: "2026-04-19T12:00:01.000Z",
      metadata: null,
      prompt: null,
      persistedActiveAttempt: null,
      payload: { exitCode: 0 },
      targetHint: BASE_TARGET,
    });
    expect(obs.attemptId).toBeNull();
    expect(obs.attemptKey).toBeNull();
    expect(obs.correlationFailure).not.toBeNull();
    expect(obs.correlationFailure?.reason).toMatch(/slot-backed|launch context|correlation/i);
  });

  test("nested sub-agent event recovers the parent's attempt key via the persisted active attempt", () => {
    const parentLc = mintLaunchContext({
      attemptKey: "frontend/auth/unit/parent-scenario/red",
      sourceAgent: "sub-agent",
      nowIso: "2026-04-19T12:00:00.000Z",
    });
    const obs = normalizeHookEvent({
      hookEvent: "tool_call",
      sessionId: "up-123",
      nowIso: "2026-04-19T12:00:05.000Z",
      metadata: null,
      prompt: null,
      persistedActiveAttempt: mkActive(parentLc),
      payload: { toolName: "bash" },
      nativeEventId: "tool-call-99",
      targetHint: BASE_TARGET,
    });
    expect(obs.attemptId).toBe(parentLc.attemptId);
    expect(obs.attemptKey).toBe(parentLc.attemptKey);
  });

  test("post-interruption retry carries a different replay fingerprint than the pre-interruption attempt", () => {
    const preLc = mintLaunchContext({
      attemptKey: "k/same/red",
      sourceAgent: "sub-agent",
      nowIso: "2026-04-19T12:00:00.000Z",
    });
    const retryLc = mintLaunchContext({
      attemptKey: "k/same/red",
      sourceAgent: "sub-agent",
      nowIso: "2026-04-19T12:00:01.000Z",
    });
    expect(retryLc.attemptId).not.toBe(preLc.attemptId);

    const preObs = normalizeHookEvent({
      hookEvent: "tool_result",
      sessionId: "up-123",
      nowIso: "2026-04-19T12:00:00.500Z",
      metadata: { [LAUNCH_CONTEXT_METADATA_KEY]: preLc },
      prompt: null,
      persistedActiveAttempt: null,
      payload: { exitCode: 1 },
      nativeEventId: "tool-result-same",
      targetHint: BASE_TARGET,
    });
    const retryObs = normalizeHookEvent({
      hookEvent: "tool_result",
      sessionId: "up-123",
      nowIso: "2026-04-19T12:00:01.500Z",
      metadata: { [LAUNCH_CONTEXT_METADATA_KEY]: retryLc },
      prompt: null,
      persistedActiveAttempt: null,
      payload: { exitCode: 1 },
      nativeEventId: "tool-result-same",
      targetHint: BASE_TARGET,
    });
    expect(preObs.fingerprint).not.toBe(retryObs.fingerprint);
  });

  test("duplicate same-launch replay (same carrier + nativeEventId + payload) produces an identical fingerprint", () => {
    const lc = mintLaunchContext({
      attemptKey: "k/same/red",
      sourceAgent: "sub-agent",
      nowIso: "2026-04-19T12:00:00.000Z",
    });
    const commonInput = {
      hookEvent: "tool_result" as const,
      sessionId: "up-123",
      nowIso: "2026-04-19T12:00:01.000Z",
      metadata: { [LAUNCH_CONTEXT_METADATA_KEY]: lc },
      prompt: null,
      persistedActiveAttempt: null,
      payload: { exitCode: 1, summary: "red failure" },
      nativeEventId: "tool-result-same",
      targetHint: BASE_TARGET,
    };
    const a = normalizeHookEvent(commonInput);
    const b = normalizeHookEvent({ ...commonInput, nowIso: "2026-04-19T12:00:02.000Z" });
    // Fingerprint is independent of `nowIso`.
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  test("derived fingerprint is stable under object key ordering of the payload", () => {
    const lc = mintLaunchContext({
      attemptKey: "k/ordering",
      sourceAgent: "sub-agent",
      nowIso: "2026-04-19T12:00:00.000Z",
    });
    const a = normalizeHookEvent({
      hookEvent: "tool_result",
      sessionId: "up-123",
      nowIso: "2026-04-19T12:00:01.000Z",
      metadata: { [LAUNCH_CONTEXT_METADATA_KEY]: lc },
      prompt: null,
      persistedActiveAttempt: null,
      payload: { a: 1, b: 2, c: 3 },
      nativeEventId: "evt-1",
      targetHint: BASE_TARGET,
    });
    const b = normalizeHookEvent({
      hookEvent: "tool_result",
      sessionId: "up-123",
      nowIso: "2026-04-19T12:00:01.000Z",
      metadata: { [LAUNCH_CONTEXT_METADATA_KEY]: lc },
      prompt: null,
      persistedActiveAttempt: null,
      payload: { c: 3, a: 1, b: 2 },
      nativeEventId: "evt-1",
      targetHint: BASE_TARGET,
    });
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  test("recovers launch context from prompt marker when metadata is absent", () => {
    const lc = mintLaunchContext({
      attemptKey: "k/prompt",
      sourceAgent: "sub-agent",
      nowIso: "2026-04-19T12:00:00.000Z",
    });
    const prompt = injectLaunchContextIntoPrompt("hi", lc);
    const obs = normalizeHookEvent({
      hookEvent: "agent_end",
      sessionId: "up-123",
      nowIso: "2026-04-19T12:00:02.000Z",
      metadata: null,
      prompt,
      persistedActiveAttempt: null,
      payload: { exitReason: "ok" },
      targetHint: BASE_TARGET,
    });
    expect(obs.attemptId).toBe(lc.attemptId);
  });

  test("recovers the target hint from prompt text when the direct hint is absent", () => {
    const lc = mintLaunchContext({
      attemptKey: "k/target-hint",
      sourceAgent: "sub-agent",
      nowIso: "2026-04-19T12:00:00.000Z",
    });
    const prompt = injectTargetHintIntoPrompt(injectLaunchContextIntoPrompt("hi", lc), BASE_TARGET);

    const obs = normalizeHookEvent({
      hookEvent: "tool_result",
      sessionId: "up-123",
      nowIso: "2026-04-19T12:00:02.000Z",
      metadata: null,
      prompt,
      persistedActiveAttempt: null,
      payload: { exitCode: 0 },
    });

    expect(obs.correlationFailure).toBeNull();
    expect(obs.target?.scenarioId).toBe(BASE_TARGET.scenarioId);
    expect(obs.target?.resolvedSlot).toBe(BASE_TARGET.resolvedSlot);
  });

  test("ignores invalid prompt-carried target hints instead of reclassifying the hook", () => {
    const lc = mintLaunchContext({
      attemptKey: "k/invalid-target-hint",
      sourceAgent: "sub-agent",
      nowIso: "2026-04-19T12:00:00.000Z",
    });
    const invalidPrompt = injectTargetHintIntoPrompt(
      injectLaunchContextIntoPrompt("hi", lc),
      { ...BASE_TARGET, actorKind: "main-orchestrator" } as any,
    );

    const obs = normalizeHookEvent({
      hookEvent: "tool_result",
      sessionId: "up-123",
      nowIso: "2026-04-19T12:00:02.000Z",
      metadata: null,
      prompt: invalidPrompt,
      persistedActiveAttempt: null,
      payload: { exitCode: 0 },
    });

    expect(obs.actorKind).toBe("slot");
    expect(obs.target).toBeNull();
    expect(obs.correlationFailure?.reason).toMatch(/target hint/i);
  });

  test("falls back to active-execution metadata only when the prompt hint is absent", () => {
    const lc = mintLaunchContext({
      attemptKey: "k/fallback-hint",
      sourceAgent: "sub-agent",
      nowIso: "2026-04-19T12:00:00.000Z",
    });

    const obs = normalizeHookEvent({
      hookEvent: "tool_call",
      sessionId: "up-123",
      nowIso: "2026-04-19T12:00:02.000Z",
      metadata: { [LAUNCH_CONTEXT_METADATA_KEY]: lc },
      prompt: null,
      persistedActiveAttempt: null,
      payload: { toolName: "ultraplan_signal" },
      fallbackTargetHint: BASE_TARGET as any,
    } as any);

    expect(obs.correlationFailure).toBeNull();
    expect(obs.target?.scenarioId).toBe(BASE_TARGET.scenarioId);
    expect(obs.target?.resolvedSlot).toBe(BASE_TARGET.resolvedSlot);
  });

  test("leaves slot-backed events correlation-failed when both prompt and fallback target hints are absent", () => {
    const lc = mintLaunchContext({
      attemptKey: "k/missing-target-hint",
      sourceAgent: "sub-agent",
      nowIso: "2026-04-19T12:00:00.000Z",
    });
    const prompt = injectLaunchContextIntoPrompt("hi", lc);

    const obs = normalizeHookEvent({
      hookEvent: "tool_result",
      sessionId: "up-123",
      nowIso: "2026-04-19T12:00:02.000Z",
      metadata: null,
      prompt,
      persistedActiveAttempt: null,
      payload: { exitCode: 0 },
    });

    expect(obs.attemptId).toBe(lc.attemptId);
    expect(obs.correlationFailure).not.toBeNull();
    expect(obs.correlationFailure?.reason.toLowerCase()).toContain("target hint");
  });
});
