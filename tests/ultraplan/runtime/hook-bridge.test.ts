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
import {
  registerUltraPlanHookBridge,
  type UltraPlanHookBridgeDeps,
  type UltraPlanSessionContext,
} from "../../../src/ultraplan/runtime/hook-bridge.js";
import {
  createTestPaths,
  createTestRepo,
  makeUltraPlanAuthored,
  makeUltraPlanManifest,
  makeUltraPlanRuntimeTracker,
} from "../fixtures.js";
import {
  getUltraplanAuthoredJsonPath,
  getUltraplanManifestPath,
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
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-hook-bridge-")); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

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
    repairOnSessionStart: mock(() => ({ actions: [], emittedBlockers: [], activeAttemptAction: "leave" as const })),
    repairOnSessionShutdown: mock(() => ({ actions: [], emittedBlockers: [], activeAttemptAction: "leave" as const })),
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
});
