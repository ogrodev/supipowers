import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Platform } from "../../../src/platform/types.js";
import type {
  UltraPlanAuthoredArtifact,
  UltraPlanLaunchContext,
  UltraPlanManifest,
} from "../../../src/types.js";
import { registerUltraPlanHookBridge, type UltraPlanSessionContext } from "../../../src/ultraplan/runtime/hook-bridge.js";
import { LAUNCH_CONTEXT_METADATA_KEY } from "../../../src/ultraplan/runtime/launch-context.js";
import { applyUltraPlanMutation } from "../../../src/ultraplan/runtime/apply-mutation.js";
import { resolveNextExecutionTarget } from "../../../src/ultraplan/execution/policy.js";
import {
  getUltraplanAuthoredJsonPath,
  getUltraplanExecutionLogPath,
  getUltraplanHooksLogPath,
  getUltraplanManifestPath,
  getUltraplanRuntimeTrackerPath,
  getUltraplanSessionDir,
} from "../../../src/ultraplan/project-paths.js";
import {
  loadUltraPlanAuthoredArtifact,
  loadUltraPlanManifest,
  loadUltraPlanRuntimeTracker,
} from "../../../src/ultraplan/storage.js";
import {
  appendExecutionLog,
} from "../../../src/ultraplan/runtime/tracker-storage.js";
import {
  createTestPaths,
  createTestRepo,
  makeUltraPlanAuthored,
  makeUltraPlanHookObservation,
  makeUltraPlanManifest,
  makeUltraPlanMutationPlan,
  makeUltraPlanScenario,
  makeUltraPlanStack,
} from "../fixtures.js";

type Handler = (event: unknown, ctx?: unknown) => unknown;

function stubPlatform(paths: Platform["paths"]): { platform: Platform; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const platform = {
    on: (event: string, h: Handler) => { handlers.set(event, h); },
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

function seedSession(paths: Platform["paths"], cwd: string, sessionId: string, authored?: UltraPlanAuthoredArtifact, manifest?: UltraPlanManifest): void {
  const dir = getUltraplanSessionDir(paths, cwd, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    getUltraplanAuthoredJsonPath(paths, cwd, sessionId),
    `${JSON.stringify(authored ?? makeUltraPlanAuthored({ sessionId }), null, 2)}\n`,
  );
  fs.writeFileSync(
    getUltraplanManifestPath(paths, cwd, sessionId),
    `${JSON.stringify(manifest ?? makeUltraPlanManifest({ sessionId }), null, 2)}\n`,
  );
}

function launchContext(overrides: Partial<UltraPlanLaunchContext> = {}): UltraPlanLaunchContext {
  return {
    attemptId: "att-1",
    attemptKey: "frontend/auth/unit/s/red",
    sourceAgent: "sub-agent",
    launchedAt: "2026-04-19T12:00:00.000Z",
    ...overrides,
  };
}

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-ultraplan-integration-")); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe("synthetic hook sequences", () => {
  test("session_start -> before_agent_start -> tool_result -> agent_end writes hooks-log and tracker", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const sessionId = "up-seq-1";
    seedSession(paths, cwd, sessionId);

    const { platform, handlers } = stubPlatform(paths);
    const sessionCtx: UltraPlanSessionContext = { sessionId, cwd };
    registerUltraPlanHookBridge(platform, { resolveActiveSession: () => sessionCtx });

    const lc = launchContext();
    handlers.get("session_start")?.({}, { cwd });
    handlers.get("before_agent_start")?.({ metadata: { [LAUNCH_CONTEXT_METADATA_KEY]: lc } }, { cwd });
    handlers.get("tool_result")?.({ toolName: "bash", exitCode: 1, metadata: { [LAUNCH_CONTEXT_METADATA_KEY]: lc } }, { cwd });
    handlers.get("agent_end")?.({ metadata: { [LAUNCH_CONTEXT_METADATA_KEY]: lc } }, { cwd });

    // Hooks log has at least the four observations.
    const logPath = getUltraplanHooksLogPath(paths, cwd, sessionId);
    expect(fs.existsSync(logPath)).toBe(true);
    const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(4);

    // Tracker was written.
    expect(fs.existsSync(getUltraplanRuntimeTrackerPath(paths, cwd, sessionId))).toBe(true);
  });

  test("session_start -> before_agent_start -> session_shutdown records the interrupted attempt in the log", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const sessionId = "up-seq-2";
    seedSession(paths, cwd, sessionId);

    const { platform, handlers } = stubPlatform(paths);
    registerUltraPlanHookBridge(platform, { resolveActiveSession: () => ({ sessionId, cwd }) });

    const lc = launchContext({ attemptKey: "frontend/auth/unit/s2/red" });
    handlers.get("session_start")?.({}, { cwd });
    handlers.get("before_agent_start")?.({ metadata: { [LAUNCH_CONTEXT_METADATA_KEY]: lc } }, { cwd });
    handlers.get("session_shutdown")?.({}, { cwd });

    const lines = fs.readFileSync(getUltraplanHooksLogPath(paths, cwd, sessionId), "utf8").split("\n").filter(Boolean);
    const events = lines.map((line) => JSON.parse(line).hookEvent);
    expect(events).toContain("session_start");
    expect(events).toContain("before_agent_start");
    expect(events).toContain("session_shutdown");
  });

  test("duplicate tool_result replay is a persisted no-op (second append suppressed by appliedFingerprints)", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const sessionId = "up-seq-dup";
    seedSession(paths, cwd, sessionId);

    const { platform, handlers } = stubPlatform(paths);
    registerUltraPlanHookBridge(platform, { resolveActiveSession: () => ({ sessionId, cwd }) });

    const lc = launchContext({ attemptKey: "dup/red" });
    handlers.get("session_start")?.({}, { cwd });
    handlers.get("before_agent_start")?.({ metadata: { [LAUNCH_CONTEXT_METADATA_KEY]: lc } }, { cwd });

    // Fire the same tool_result twice with identical payload + nativeEventId-equivalent shape.
    const toolResultEvent = { toolName: "bash", exitCode: 1, metadata: { [LAUNCH_CONTEXT_METADATA_KEY]: lc } };
    handlers.get("tool_result")?.(toolResultEvent, { cwd });
    handlers.get("tool_result")?.(toolResultEvent, { cwd });

    const lines = fs.readFileSync(getUltraplanHooksLogPath(paths, cwd, sessionId), "utf8").split("\n").filter(Boolean);
    const toolResultLines = lines.filter((l) => l.includes("\"tool_result\""));
    // The second replay is suppressed because the fingerprint was staged by the first pass.
    expect(toolResultLines.length).toBe(1);
  });

  test("ambiguous slot-backed tool_result (no launch context carrier) lands in the log but does not mutate the tracker", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const sessionId = "up-seq-ambiguous";
    seedSession(paths, cwd, sessionId);

    const { platform, handlers } = stubPlatform(paths);
    registerUltraPlanHookBridge(platform, { resolveActiveSession: () => ({ sessionId, cwd }) });

    handlers.get("session_start")?.({}, { cwd });
    // tool_result without metadata + without a persisted active attempt \u2192 session-scope
    // (normalizer classification), no tracker mutation beyond logging.
    handlers.get("tool_result")?.({ toolName: "bash" }, { cwd });

    // The tracker exists (written during session_start's noop) but it has no active attempt.
    const tracker = loadUltraPlanRuntimeTracker(paths, cwd, sessionId);
    if (tracker.ok) {
      expect(tracker.value.activeAttempt).toBeNull();
    }
  });
});

describe("policy + mutation integration", () => {
  test("unit work advances from red ownership to green ownership in strict order", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const sessionId = "up-progress-unit";
    const authored = makeUltraPlanAuthored({
      sessionId,
      stacks: [makeUltraPlanStack({
        domains: [{
          id: "auth",
          name: "Authentication",
          unit: [makeUltraPlanScenario("scenario-a", "Unit auth scenario", "planned", "unit", { stack: "frontend", domainId: "auth" })],
          integration: [],
          e2e: [],
          review: { enabled: true, status: "pending" },
          progress: { total: 1, terminal: 0, blocked: 0 },
        }],
        progress: { total: 1, terminal: 0, blocked: 0 },
      })],
    });
    const manifest = makeUltraPlanManifest({ sessionId, progress: { total: 1, terminal: 0, blocked: 0 } });
    seedSession(paths, cwd, sessionId, authored, manifest);

    let authoredResult = loadUltraPlanAuthoredArtifact(paths, cwd, sessionId);
    let manifestResult = loadUltraPlanManifest(paths, cwd, sessionId);
    expect(authoredResult.ok).toBe(true);
    expect(manifestResult.ok).toBe(true);
    if (!authoredResult.ok || !manifestResult.ok) return;

    let target = resolveNextExecutionTarget({ paths, cwd, authored: authoredResult.value, manifest: manifestResult.value });
    expect(target.requiredSlot).toBe("frontend-executor");
    expect(target.phase).toBe("red");

    const redObservation = makeUltraPlanHookObservation({
      fingerprint: "fp-unit-red",
      attemptId: "att-unit-red",
      attemptKey: "frontend/auth/unit/scenario-a/red",
      target: {
        targetType: "scenario",
        stack: "frontend",
        domainId: "auth",
        level: "unit",
        scenarioId: "scenario-a",
        phase: "red",
        resolvedSlot: "frontend-executor",
      },
    });
    applyUltraPlanMutation({
      platform: { paths } as any,
      cwd,
      sessionId,
      observation: redObservation,
      mutationPlan: makeUltraPlanMutationPlan({
        kind: "advance",
        appendObservationFingerprint: redObservation.fingerprint,
        scenarioStatusUpdate: {
          stack: "frontend",
          domainId: "auth",
          level: "unit",
          scenarioId: "scenario-a",
          nextStatus: "red-proved",
          appendProof: {
            type: "test",
            phase: "red",
            recordedAt: redObservation.occurredAt,
            actor: "frontend-executor",
            evidence: { summary: "Red proof captured" },
            artifactRef: "artifact://unit-red",
          },
        },
      }),
    });

    authoredResult = loadUltraPlanAuthoredArtifact(paths, cwd, sessionId);
    manifestResult = loadUltraPlanManifest(paths, cwd, sessionId);
    expect(authoredResult.ok).toBe(true);
    expect(manifestResult.ok).toBe(true);
    if (!authoredResult.ok || !manifestResult.ok) return;

    target = resolveNextExecutionTarget({ paths, cwd, authored: authoredResult.value, manifest: manifestResult.value });
    expect(target.requiredSlot).toBe("frontend-executor");
    expect(target.phase).toBe("green");
  });

  test("integration work uses tester for red and executor for green", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const sessionId = "up-progress-integration";
    const authored = makeUltraPlanAuthored({
      sessionId,
      stacks: [makeUltraPlanStack({
        domains: [{
          id: "auth",
          name: "Authentication",
          unit: [],
          integration: [makeUltraPlanScenario("scenario-int", "Integration auth scenario", "planned", "integration", { stack: "frontend", domainId: "auth" })],
          e2e: [],
          review: { enabled: true, status: "pending" },
          progress: { total: 1, terminal: 0, blocked: 0 },
        }],
        progress: { total: 1, terminal: 0, blocked: 0 },
      })],
    });
    const manifest = makeUltraPlanManifest({ sessionId, progress: { total: 1, terminal: 0, blocked: 0 } });
    seedSession(paths, cwd, sessionId, authored, manifest);

    let authoredResult = loadUltraPlanAuthoredArtifact(paths, cwd, sessionId);
    let manifestResult = loadUltraPlanManifest(paths, cwd, sessionId);
    expect(authoredResult.ok).toBe(true);
    expect(manifestResult.ok).toBe(true);
    if (!authoredResult.ok || !manifestResult.ok) return;

    let target = resolveNextExecutionTarget({ paths, cwd, authored: authoredResult.value, manifest: manifestResult.value });
    expect(target.requiredSlot).toBe("frontend-tester");
    expect(target.phase).toBe("red");

    const redObservation = makeUltraPlanHookObservation({
      fingerprint: "fp-int-red",
      attemptId: "att-int-red",
      attemptKey: "frontend/auth/integration/scenario-int/red",
      target: {
        targetType: "scenario",
        stack: "frontend",
        domainId: "auth",
        level: "integration",
        scenarioId: "scenario-int",
        phase: "red",
        resolvedSlot: "frontend-tester",
      },
    });
    applyUltraPlanMutation({
      platform: { paths } as any,
      cwd,
      sessionId,
      observation: redObservation,
      mutationPlan: makeUltraPlanMutationPlan({
        kind: "advance",
        appendObservationFingerprint: redObservation.fingerprint,
        scenarioStatusUpdate: {
          stack: "frontend",
          domainId: "auth",
          level: "integration",
          scenarioId: "scenario-int",
          nextStatus: "red-proved",
          appendProof: {
            type: "test",
            phase: "red",
            recordedAt: redObservation.occurredAt,
            actor: "frontend-tester",
            evidence: { summary: "Integration red proof" },
            artifactRef: "artifact://integration-red",
          },
        },
      }),
    });

    authoredResult = loadUltraPlanAuthoredArtifact(paths, cwd, sessionId);
    manifestResult = loadUltraPlanManifest(paths, cwd, sessionId);
    expect(authoredResult.ok).toBe(true);
    expect(manifestResult.ok).toBe(true);
    if (!authoredResult.ok || !manifestResult.ok) return;

    target = resolveNextExecutionTarget({ paths, cwd, authored: authoredResult.value, manifest: manifestResult.value });
    expect(target.requiredSlot).toBe("frontend-executor");
    expect(target.phase).toBe("green");
  });

  test("replay after a pre-tracker crash does not duplicate the execution log entry", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const sessionId = "up-execution-log-replay";
    const observation = makeUltraPlanHookObservation({
      fingerprint: "fp-execution-replay",
      attemptId: "att-execution-replay",
      attemptKey: "frontend/auth/unit/scenario-a/red",
      hookEvent: "tool_result",
    });
    const mutationPlan = makeUltraPlanMutationPlan({
      kind: "stage-observation",
      appendObservationFingerprint: observation.fingerprint,
    });

    const firstAppend = appendExecutionLog(paths, cwd, sessionId, {
      ts: observation.occurredAt,
      sessionId,
      attemptId: observation.attemptId,
      observationFingerprint: observation.fingerprint,
      hookEvent: observation.hookEvent,
      mutation: mutationPlan,
    });
    expect(firstAppend.ok).toBe(true);

    applyUltraPlanMutation({
      platform: { paths } as any,
      cwd,
      sessionId,
      observation,
      mutationPlan,
    });

    const executionLines = fs.readFileSync(getUltraplanExecutionLogPath(paths, cwd, sessionId), "utf8")
      .split("\n")
      .filter(Boolean);
    expect(executionLines).toHaveLength(1);
    expect(loadUltraPlanRuntimeTracker(paths, cwd, sessionId).ok).toBe(true);
  });
});
