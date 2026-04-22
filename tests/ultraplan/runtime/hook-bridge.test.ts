import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Platform } from "../../../src/platform/types.js";
import type {
  UltraPlanHookObservation,
  UltraPlanMutationPlan,
  UltraPlanRuntimeTracker,
} from "../../../src/types.js";
import { registerUltraPlanHookBridge, type UltraPlanHookBridgeDeps, type UltraPlanSessionContext } from "../../../src/ultraplan/runtime/hook-bridge.js";
import {
  bindActiveUltraPlanExecution,
  clearActiveUltraPlanExecution,
} from "../../../src/ultraplan/runtime/active-execution.js";
import { reduce } from "../../../src/ultraplan/runtime/reducer.js";
import { LAUNCH_CONTEXT_METADATA_KEY } from "../../../src/ultraplan/runtime/launch-context.js";
import {
  createTestPaths,
  createTestRepo,
  makeActiveUltraPlanExecution,
  makeUltraPlanAuthored,
  makeUltraPlanExecutionTarget,
  makeUltraPlanManifest,
  makeUltraPlanRuntimeTracker,
} from "../fixtures.js";
import {
  getUltraplanAuthoredJsonPath,
  getUltraplanHooksLogPath,
  getUltraplanManifestPath,
  getUltraplanRuntimeTrackerPath,
  getUltraplanSessionDir,
} from "../../../src/ultraplan/project-paths.js";

type Handler = (event: unknown, ctx?: unknown) => unknown;

function makeStubPlatform(paths: ReturnType<typeof createTestPaths>): {
  platform: Platform;
  handlers: Map<string, Handler>;
} {
  const handlers = new Map<string, Handler>();
  const platform = {
    on: (event: string, handler: Handler) => { handlers.set(event, handler); },
    paths,
    capabilities: { agentSessions: true, compactionHooks: false, customWidgets: false, registerTool: false },
    registerCommand: mock(),
    getCommands: mock(() => []),
    sendMessage: mock(),
    sendUserMessage: mock(),
    getActiveTools: mock(() => []),
    registerMessageRenderer: mock(),
    createAgentSession: mock(),
    exec: mock(),
  } as unknown as Platform;
  return { platform, handlers };
}

function makeNoopMutationPlan(): UltraPlanMutationPlan {
  return {
    kind: "noop",
    rationale: "test",
    appendObservationFingerprint: null,
    scenarioStatusUpdate: null,
    reviewStatusUpdate: null,
    blockerUpdate: null,
    cursorUpdate: null,
    sessionStateUpdate: null,
    trackerAttemptFinalization: null,
    recomputeProgress: false,
    repairActions: [],
    notes: [],
  };
}

function makeObservation(overrides: Partial<UltraPlanHookObservation> = {}): UltraPlanHookObservation {
  return {
    sessionId: "up-123",
    hookEvent: "tool_result",
    actorKind: "slot",
    attemptId: "att-1",
    attemptKey: "k/red",
    sourceAgent: "sub-agent",
    occurredAt: "2026-04-19T12:00:01.000Z",
    causationId: null,
    fingerprint: "obs-fp",
    target: null,
    correlationFailure: null,
    payloadSummary: "p",
    ...overrides,
  };
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-hook-bridge-"));
  clearActiveUltraPlanExecution();
});
afterEach(() => {
  clearActiveUltraPlanExecution();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedCanonicalGlobalSession(
  paths: ReturnType<typeof createTestPaths>,
  cwd: string,
  sessionId: string,
): void {
  const dir = getUltraplanSessionDir(paths, cwd, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    getUltraplanAuthoredJsonPath(paths, cwd, sessionId),
    `${JSON.stringify(makeUltraPlanAuthored({ sessionId }), null, 2)}\n`,
  );
  fs.writeFileSync(
    getUltraplanManifestPath(paths, cwd, sessionId),
    `${JSON.stringify(makeUltraPlanManifest({ sessionId }), null, 2)}\n`,
  );
}

function launchContext() {
  return {
    attemptId: "att-1",
    attemptKey: "frontend/auth/unit/scenario-login-form-renders/red",
    sourceAgent: "sub-agent" as const,
    launchedAt: "2026-04-19T12:00:00.000Z",
  };
}

function buildInjectedDeps(overrides: Partial<UltraPlanHookBridgeDeps>, sessionCtx: UltraPlanSessionContext | null): UltraPlanHookBridgeDeps {
  return {
    resolveActiveSession: () => sessionCtx,
    normalize: mock((input: any) => makeObservation({
      hookEvent: input.hookEvent,
      sessionId: input.sessionId,
      fingerprint: `fp-${input.hookEvent}`,
    })),
    loadTracker: mock(() => ({ ok: true, value: makeUltraPlanRuntimeTracker() } as any)),
    saveTrackerAtomic: mock(() => ({ ok: true, value: "" } as any)),
    reduce: mock(() => makeNoopMutationPlan()),
    applyMutationPlan: mock(() => undefined),
    repairOnSessionStart: mock(() => ({
      actions: [],
      emittedBlockers: [],
      activeAttemptAction: "leave" as const,
      pendingMutationAction: "leave" as const,
    })),
    repairOnSessionShutdown: mock(() => ({
      actions: [],
      emittedBlockers: [],
      activeAttemptAction: "leave" as const,
      pendingMutationAction: "leave" as const,
    })),
    resolveSessionMigration: mock(() => ({ kind: "native" } as const)),
    ...overrides,
  };
}

describe("registerUltraPlanHookBridge", () => {
  test("registers handlers for all six UltraPlan-relevant hooks", () => {
    const paths = createTestPaths(tmpDir);
    const { platform, handlers } = makeStubPlatform(paths);
    const deps = buildInjectedDeps({}, null);
    registerUltraPlanHookBridge(platform, deps);

    for (const hook of [
      "session_start",
      "before_agent_start",
      "tool_call",
      "tool_result",
      "agent_end",
      "session_shutdown",
    ]) {
      expect(handlers.has(hook)).toBe(true);
    }
  });

  test("no-op: when resolveActiveSession returns null, no UltraPlan machinery runs", () => {
    const paths = createTestPaths(tmpDir);
    const { platform, handlers } = makeStubPlatform(paths);
    const deps = buildInjectedDeps({}, null);
    registerUltraPlanHookBridge(platform, deps);

    handlers.get("tool_result")?.({ toolName: "bash" }, { cwd: "/some/cwd" });
    handlers.get("session_start")?.({}, { cwd: "/some/cwd" });

    expect((deps.normalize as any).mock.calls.length).toBe(0);
    expect((deps.reduce as any).mock.calls.length).toBe(0);
    expect((deps.applyMutationPlan as any).mock.calls.length).toBe(0);
    expect((deps.repairOnSessionStart as any).mock.calls.length).toBe(0);
  });

  test("session_start: runs migration check, then session_start repair", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const sessionId = "up-hb-1";
    seedCanonicalGlobalSession(paths, cwd, sessionId);

    const { platform, handlers } = makeStubPlatform(paths);
    const deps = buildInjectedDeps({}, { sessionId, cwd });
    registerUltraPlanHookBridge(platform, deps);

    handlers.get("session_start")?.({}, { cwd });

    expect((deps.resolveSessionMigration as any).mock.calls.length).toBeGreaterThanOrEqual(1);
    expect((deps.repairOnSessionStart as any).mock.calls.length).toBe(1);
    expect((deps.normalize as any).mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  test("tool_result: normalizes, reduces, and applies the mutation plan", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const sessionId = "up-hb-2";
    seedCanonicalGlobalSession(paths, cwd, sessionId);

    const { platform, handlers } = makeStubPlatform(paths);
    const deps = buildInjectedDeps({}, { sessionId, cwd });
    registerUltraPlanHookBridge(platform, deps);

    handlers.get("tool_result")?.({ toolName: "bash", exitCode: 0 }, { cwd });

    expect((deps.normalize as any).mock.calls.length).toBe(1);
    expect((deps.reduce as any).mock.calls.length).toBe(1);
    expect((deps.applyMutationPlan as any).mock.calls.length).toBe(1);
  });

  test("session_shutdown: runs session_shutdown repair and reducer", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const sessionId = "up-hb-3";
    seedCanonicalGlobalSession(paths, cwd, sessionId);

    const { platform, handlers } = makeStubPlatform(paths);
    const deps = buildInjectedDeps({}, { sessionId, cwd });
    registerUltraPlanHookBridge(platform, deps);

    handlers.get("session_shutdown")?.({}, { cwd });

    expect((deps.repairOnSessionShutdown as any).mock.calls.length).toBe(1);
    expect((deps.reduce as any).mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  test("idempotent replay: firing the same tool_result twice produces two reducer calls but applyMutationPlan is invoked each time (dedupe is the reducer's job)", () => {
    // The bridge itself is stateless. Dedupe lives in the reducer + tracker. The bridge must
    // not swallow events: the test simply asserts that replaying does not throw and that every
    // invocation flows through the pipeline.
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const sessionId = "up-hb-replay";
    seedCanonicalGlobalSession(paths, cwd, sessionId);

    const { platform, handlers } = makeStubPlatform(paths);
    const deps = buildInjectedDeps({}, { sessionId, cwd });
    registerUltraPlanHookBridge(platform, deps);

    handlers.get("tool_result")?.({ toolName: "bash" }, { cwd });
    handlers.get("tool_result")?.({ toolName: "bash" }, { cwd });

    expect((deps.normalize as any).mock.calls.length).toBe(2);
    expect((deps.reduce as any).mock.calls.length).toBe(2);
    expect((deps.applyMutationPlan as any).mock.calls.length).toBe(2);
  });

  test("before_agent_start falls back to the active execution only when the launch context matches", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const activeExecution = makeActiveUltraPlanExecution({
      sessionId: "up-active-fallback",
      cwd,
      launchContext: launchContext(),
    });
    bindActiveUltraPlanExecution(activeExecution);

    const { platform, handlers } = makeStubPlatform(paths);
    const deps = buildInjectedDeps({}, null);
    registerUltraPlanHookBridge(platform, deps);

    handlers.get("before_agent_start")?.({ metadata: { [LAUNCH_CONTEXT_METADATA_KEY]: launchContext() } }, { cwd });

    expect((deps.normalize as any).mock.calls.length).toBe(1);
  });

  test("ignores unrelated hook events when only the active-execution registry is populated", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    bindActiveUltraPlanExecution(makeActiveUltraPlanExecution({ sessionId: "up-active-fallback", cwd }));

    const { platform, handlers } = makeStubPlatform(paths);
    const deps = buildInjectedDeps({}, null);
    registerUltraPlanHookBridge(platform, deps);

    handlers.get("tool_result")?.({ toolName: "bash" }, { cwd });

    expect((deps.normalize as any).mock.calls.length).toBe(0);
    expect((deps.reduce as any).mock.calls.length).toBe(0);
    expect((deps.applyMutationPlan as any).mock.calls.length).toBe(0);
  });

  test("tool_result falls back to the active execution only after the matching attempt is active", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const activeExecution = makeActiveUltraPlanExecution({
      sessionId: "up-target-fallback",
      cwd,
      launchContext: launchContext(),
      target: makeUltraPlanExecutionTarget({
        scenarioId: "scenario-from-active-execution",
        requiredSlot: "frontend-executor",
      }),
    });
    bindActiveUltraPlanExecution(activeExecution);

    const { platform, handlers } = makeStubPlatform(paths);
    const deps = buildInjectedDeps({
      loadTracker: mock(() => ({
        ok: true,
        value: makeUltraPlanRuntimeTracker({
          activeAttempt: {
            attemptId: activeExecution.launchContext.attemptId,
            attemptKey: activeExecution.launchContext.attemptKey,
            launchContext: activeExecution.launchContext,
            cursorSnapshot: null,
            observations: [],
            proofCandidates: [],
            blockerCandidates: [],
            outcome: null,
            startedAt: activeExecution.launchContext.launchedAt,
            finalizedAt: null,
          },
        }),
      }) as any),
    }, null);
    registerUltraPlanHookBridge(platform, deps);

    handlers.get("tool_result")?.({ toolName: "bash" }, { cwd });

    const normalizeInput = (deps.normalize as any).mock.calls[0][0];
    expect(normalizeInput.fallbackTargetHint.scenarioId).toBe("scenario-from-active-execution");
    expect(normalizeInput.fallbackTargetHint.resolvedSlot).toBe("frontend-executor");
  });

  test("does not borrow fallbackTargetHint from a different explicit session", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    bindActiveUltraPlanExecution(makeActiveUltraPlanExecution({
      sessionId: "up-other-session",
      cwd,
      launchContext: launchContext(),
      target: makeUltraPlanExecutionTarget({ scenarioId: "scenario-from-active-execution" }),
    }));

    const { platform, handlers } = makeStubPlatform(paths);
    const deps = buildInjectedDeps({}, { sessionId: "up-explicit-session", cwd });
    registerUltraPlanHookBridge(platform, deps);

    handlers.get("tool_result")?.({ toolName: "bash" }, { cwd });

    const normalizeInput = (deps.normalize as any).mock.calls[0][0];
    expect(normalizeInput.fallbackTargetHint).toBeUndefined();
  });

  test("before_agent_start with an existing active attempt reduces to a nested-dispatch block", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const sessionId = "up-nested-dispatch";
    seedCanonicalGlobalSession(paths, cwd, sessionId);

    const { platform, handlers } = makeStubPlatform(paths);
    const deps = buildInjectedDeps({
      loadTracker: mock(() => ({
        ok: true,
        value: makeUltraPlanRuntimeTracker({
          activeAttempt: {
            attemptId: "att-parent",
            attemptKey: "frontend/auth/unit/scenario-login-form-renders/red",
            launchContext: {
              attemptId: "att-parent",
              attemptKey: "frontend/auth/unit/scenario-login-form-renders/red",
              sourceAgent: "sub-agent",
              launchedAt: "2026-04-19T12:00:00.000Z",
            },
            cursorSnapshot: {
              targetType: "scenario",
              stack: "frontend",
              domainId: "auth",
              level: "unit",
              scenarioId: "scenario-login-form-renders",
              phase: "red",
              status: "planned",
              summary: "frontend / auth / unit / Login form renders",
            },
            observations: [],
            proofCandidates: [],
            blockerCandidates: [],
            outcome: null,
            startedAt: "2026-04-19T12:00:00.000Z",
            finalizedAt: null,
          },
        }),
      }) as any),
      normalize: mock(() => makeObservation({
        hookEvent: "before_agent_start",
        fingerprint: "fp-before-nested",
        attemptId: "att-child",
        attemptKey: "frontend/auth/unit/scenario-login-form-renders/red",
        target: {
          targetType: "scenario",
          stack: "frontend",
          domainId: "auth",
          level: "unit",
          scenarioId: "scenario-login-form-renders",
          phase: "red",
          resolvedSlot: "frontend-executor",
        },
      })) as any,
      reduce: reduce as any,
    }, { sessionId, cwd });
    registerUltraPlanHookBridge(platform, deps);

    handlers.get("before_agent_start")?.({ metadata: { [LAUNCH_CONTEXT_METADATA_KEY]: launchContext() } }, { cwd });

    const mutationPlan = (deps.applyMutationPlan as any).mock.calls[0][0].mutationPlan;
    expect(mutationPlan.kind).toBe("block");
    expect(mutationPlan.blockerUpdate.nextValue.code).toBe("unsafe-repair-required");
  });

  test("uses the real apply-mutation default when no override is provided", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const sessionId = "up-real-apply";
    seedCanonicalGlobalSession(paths, cwd, sessionId);
    const activeExecution = makeActiveUltraPlanExecution({
      sessionId,
      cwd,
      launchContext: launchContext(),
      target: makeUltraPlanExecutionTarget(),
    });
    bindActiveUltraPlanExecution(activeExecution);

    const { platform, handlers } = makeStubPlatform(paths);
    registerUltraPlanHookBridge(platform, { resolveActiveSession: () => null });

    handlers.get("tool_result")?.({
      toolName: "ultraplan_signal",
      summary: "Tests passed",
      details: { payload: { kind: "proof", proof: { evidence: { summary: "Tests passed", metadata: { command: "bun test" } } } } },
      metadata: { [LAUNCH_CONTEXT_METADATA_KEY]: launchContext() },
    }, { cwd });

    expect(fs.existsSync(getUltraplanHooksLogPath(paths, cwd, sessionId))).toBe(true);
    expect(fs.existsSync(getUltraplanRuntimeTrackerPath(paths, cwd, sessionId))).toBe(true);
  });
});
