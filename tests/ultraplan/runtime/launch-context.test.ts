import { describe, expect, test } from "bun:test";
import type {
  UltraPlanAttemptRecord,
  UltraPlanLaunchContext,
} from "../../../src/types.js";
import {
  injectLaunchContextIntoPrompt,
  injectTargetHintIntoPrompt,
  LAUNCH_CONTEXT_METADATA_KEY,
  LAUNCH_CONTEXT_PROMPT_MARKER,
  mintLaunchContext,
  recoverLaunchContextFromEvent,
  recoverTargetHintFromPrompt,
  TARGET_HINT_PROMPT_MARKER,
} from "../../../src/ultraplan/runtime/launch-context.js";

function parentAttempt(overrides: Partial<UltraPlanAttemptRecord> = {}): UltraPlanAttemptRecord {
  return {
    attemptId: "att-parent-1",
    attemptKey: "frontend/auth/unit/scenario-login-form-renders/red",
    launchContext: {
      attemptId: "att-parent-1",
      attemptKey: "frontend/auth/unit/scenario-login-form-renders/red",
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

const TARGET_HINT = {
  targetType: "scenario" as const,
  stack: "frontend" as const,
  domainId: "auth",
  level: "unit" as const,
  scenarioId: "scenario-login-form-renders",
  phase: "red" as const,
  resolvedSlot: "frontend-executor",
  actorKind: "slot" as const,
  sourceAgent: "sub-agent" as const,
};

describe("mintLaunchContext", () => {
  test("produces a context with attemptId, attemptKey, sourceAgent, and launchedAt", () => {
    const ctx = mintLaunchContext({
      attemptKey: "frontend/auth/unit/scenario-x/red",
      sourceAgent: "sub-agent",
      nowIso: "2026-04-19T12:00:00.000Z",
    });
    expect(ctx.attemptKey).toBe("frontend/auth/unit/scenario-x/red");
    expect(ctx.sourceAgent).toBe("sub-agent");
    expect(ctx.launchedAt).toBe("2026-04-19T12:00:00.000Z");
    expect(ctx.attemptId.length).toBeGreaterThan(0);
  });

  test("mints distinct attemptIds across successive calls for the same key", () => {
    const a = mintLaunchContext({
      attemptKey: "k1",
      sourceAgent: "sub-agent",
      nowIso: "2026-04-19T12:00:00.000Z",
    });
    const b = mintLaunchContext({
      attemptKey: "k1",
      sourceAgent: "sub-agent",
      nowIso: "2026-04-19T12:00:00.001Z",
    });
    expect(a.attemptId).not.toBe(b.attemptId);
  });

  test("nested sub-agent launched under an active parent attempt inherits parent attemptId and attemptKey", () => {
    const parent = parentAttempt().launchContext;
    const nested = mintLaunchContext({
      attemptKey: "frontend/auth/unit/sub-scenario/red",
      sourceAgent: "sub-agent",
      nowIso: "2026-04-19T12:00:05.000Z",
      inheritFrom: parent,
    });
    expect(nested.attemptId).toBe(parent.attemptId);
    expect(nested.attemptKey).toBe(parent.attemptKey);
    expect(nested.sourceAgent).toBe("sub-agent");
    expect(nested.launchedAt).toBe("2026-04-19T12:00:05.000Z");
  });

  test("retry after an interrupted or blocked attempt mints a fresh attemptId (no reuse)", () => {
    const previous = mintLaunchContext({
      attemptKey: "k-same",
      sourceAgent: "sub-agent",
      nowIso: "2026-04-19T12:00:00.000Z",
    });
    const retry = mintLaunchContext({
      attemptKey: "k-same",
      sourceAgent: "sub-agent",
      nowIso: "2026-04-19T12:00:01.000Z",
      // explicit retry semantics: caller did NOT pass inheritFrom
    });
    expect(retry.attemptId).not.toBe(previous.attemptId);
  });
});

describe("injectLaunchContextIntoPrompt", () => {
  test("injects the exact ULTRAPLAN_LAUNCH_CONTEXT=<json> marker line", () => {
    const ctx: UltraPlanLaunchContext = {
      attemptId: "att-1",
      attemptKey: "k/red",
      sourceAgent: "sub-agent",
      launchedAt: "2026-04-19T12:00:00.000Z",
    };
    const prompt = "you are a tester";
    const injected = injectLaunchContextIntoPrompt(prompt, ctx);
    expect(injected).toContain(prompt);
    expect(injected).toContain(`${LAUNCH_CONTEXT_PROMPT_MARKER}=`);
    const line = injected
      .split("\n")
      .find((l) => l.startsWith(`${LAUNCH_CONTEXT_PROMPT_MARKER}=`));
    expect(line).toBeDefined();
    const json = line!.slice(`${LAUNCH_CONTEXT_PROMPT_MARKER}=`.length);
    expect(JSON.parse(json)).toEqual(ctx);
  });

  test("is idempotent: injecting into an already-injected prompt yields the same marker line", () => {
    const ctx: UltraPlanLaunchContext = {
      attemptId: "att-1",
      attemptKey: "k/red",
      sourceAgent: "sub-agent",
      launchedAt: "2026-04-19T12:00:00.000Z",
    };
    const once = injectLaunchContextIntoPrompt("p", ctx);
    const twice = injectLaunchContextIntoPrompt(once, ctx);
    const markers = twice.match(new RegExp(`${LAUNCH_CONTEXT_PROMPT_MARKER}=`, "g")) ?? [];
    expect(markers.length).toBe(1);
  });
});

describe("target-hint prompt carrier", () => {
  test("injects the exact ULTRAPLAN_TARGET_HINT=<json> marker line", () => {
    const injected = injectTargetHintIntoPrompt("you are a tester", TARGET_HINT);

    expect(injected).toContain(`${TARGET_HINT_PROMPT_MARKER}=`);
    const line = injected.split("\n").find((value) => value.startsWith(`${TARGET_HINT_PROMPT_MARKER}=`));
    expect(line).toBeDefined();
    expect(JSON.parse(line!.slice(`${TARGET_HINT_PROMPT_MARKER}=`.length))).toEqual(TARGET_HINT);
  });

  test("is idempotent and keeps only one target-hint marker", () => {
    const once = injectTargetHintIntoPrompt("p", TARGET_HINT);
    const twice = injectTargetHintIntoPrompt(once, TARGET_HINT);
    const markers = twice.match(new RegExp(`${TARGET_HINT_PROMPT_MARKER}=`, "g")) ?? [];

    expect(markers.length).toBe(1);
  });

  test("recovers the target hint from prompt text", () => {
    const prompt = injectTargetHintIntoPrompt("p", TARGET_HINT);

    expect(recoverTargetHintFromPrompt(prompt)).toEqual(TARGET_HINT);
  });

  test("ignores malformed target-hint JSON", () => {
    expect(recoverTargetHintFromPrompt(`${TARGET_HINT_PROMPT_MARKER}=not-json`)).toBeNull();
  });

  test("rejects target-hint prompt carriers whose enum fields are not slot-backed values", () => {
    const invalidHint = {
      ...TARGET_HINT,
      actorKind: "main-orchestrator",
      sourceAgent: "main",
      phase: "not-a-phase",
    };

    expect(recoverTargetHintFromPrompt(
      `${TARGET_HINT_PROMPT_MARKER}=${JSON.stringify(invalidHint)}`,
    )).toBeNull();
  });
});

describe("recoverLaunchContextFromEvent", () => {
  const ctx: UltraPlanLaunchContext = {
    attemptId: "att-1",
    attemptKey: "k/red",
    sourceAgent: "sub-agent",
    launchedAt: "2026-04-19T12:00:00.000Z",
  };

  test("prefers metadata key over prompt marker over persisted active attempt", () => {
    const differentFromMeta: UltraPlanLaunchContext = {
      ...ctx,
      attemptId: "att-prompt",
    };
    const promptString = injectLaunchContextIntoPrompt("prompt", differentFromMeta);
    const persisted = parentAttempt({
      attemptId: "att-persisted",
      attemptKey: "k/red",
      launchContext: { ...ctx, attemptId: "att-persisted" },
    });

    const recovered = recoverLaunchContextFromEvent({
      metadata: { [LAUNCH_CONTEXT_METADATA_KEY]: ctx },
      prompt: promptString,
      persistedActiveAttempt: persisted,
    });
    expect(recovered).toEqual(ctx);
  });

  test("falls back to the prompt marker when metadata is absent", () => {
    const promptString = injectLaunchContextIntoPrompt("anything", ctx);
    const recovered = recoverLaunchContextFromEvent({
      metadata: null,
      prompt: promptString,
      persistedActiveAttempt: null,
    });
    expect(recovered).toEqual(ctx);
  });

  test("uses persisted active attempt only as a last-resort when both metadata and prompt are absent", () => {
    const persisted = parentAttempt({ attemptId: "att-persist", launchContext: { ...ctx, attemptId: "att-persist" } });
    const recovered = recoverLaunchContextFromEvent({
      metadata: null,
      prompt: null,
      persistedActiveAttempt: persisted,
    });
    expect(recovered).toEqual(persisted.launchContext);
  });

  test("returns null when no carrier is present", () => {
    const recovered = recoverLaunchContextFromEvent({
      metadata: null,
      prompt: null,
      persistedActiveAttempt: null,
    });
    expect(recovered).toBeNull();
  });

  test("same-launch replay of the same not-yet-finalized launch event reuses the current attemptId", () => {
    // Recovery is pure: feeding the same carrier twice must return identical payloads.
    const promptString = injectLaunchContextIntoPrompt("p", ctx);
    const first = recoverLaunchContextFromEvent({
      metadata: null,
      prompt: promptString,
      persistedActiveAttempt: parentAttempt({ attemptId: ctx.attemptId, launchContext: ctx }),
    });
    const second = recoverLaunchContextFromEvent({
      metadata: null,
      prompt: promptString,
      persistedActiveAttempt: parentAttempt({ attemptId: ctx.attemptId, launchContext: ctx }),
    });
    expect(first).toEqual(ctx);
    expect(second).toEqual(ctx);
    expect(first).toEqual(second);
  });

  test("ignores a malformed metadata payload and falls through to prompt marker", () => {
    const promptString = injectLaunchContextIntoPrompt("p", ctx);
    const recovered = recoverLaunchContextFromEvent({
      metadata: { [LAUNCH_CONTEXT_METADATA_KEY]: { not: "a launch context" } },
      prompt: promptString,
      persistedActiveAttempt: null,
    });
    expect(recovered).toEqual(ctx);
  });

  test("ignores a prompt marker with invalid JSON and falls back to persisted attempt", () => {
    const persisted = parentAttempt({ attemptId: ctx.attemptId, launchContext: ctx });
    const recovered = recoverLaunchContextFromEvent({
      metadata: null,
      prompt: `${LAUNCH_CONTEXT_PROMPT_MARKER}=not-json-here`,
      persistedActiveAttempt: persisted,
    });
    expect(recovered).toEqual(ctx);
  });
});
