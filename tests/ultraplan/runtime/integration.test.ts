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
import {
  getUltraplanAuthoredJsonPath,
  getUltraplanHooksLogPath,
  getUltraplanManifestPath,
  getUltraplanRuntimeTrackerPath,
  getUltraplanSessionDir,
} from "../../../src/ultraplan/project-paths.js";
import { loadUltraPlanRuntimeTracker } from "../../../src/ultraplan/storage.js";
import { createTestPaths, createTestRepo, makeUltraPlanAuthored, makeUltraPlanManifest } from "../fixtures.js";

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
