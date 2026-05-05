// tests/context-mode/hooks-llm-compaction.test.ts
//
// Phase B of the token-saving followups: when contextMode.llmSummarization is
// enabled and the deterministic resume snapshot exceeds llmThreshold, the
// session_before_compact handler asks an LLM to summarize the snapshot and
// overwrites the persisted resume row with the summary on success.
//
// The deterministic snapshot is the contract; the LLM step is best-effort.
// Failures, missing models, and short summaries must NOT clobber the
// deterministic snapshot.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { rmDirWithRetry } from "../helpers/fs.js";
import {
  registerContextModeHooks,
  _resetCache,
  getEventStore,
  getSessionId,
} from "../../src/context-mode/hooks.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type { SupipowersConfig } from "../../src/types.js";
import { createMockPlatform } from "../../src/platform/test-utils.js";
import type { PlatformPaths } from "../../src/platform/types.js";

let tmpDir: string;
let activeShutdown: (() => void) | null = null;

function createPlatformWithTmpPaths(overrides?: Partial<Parameters<typeof createMockPlatform>[0]>) {
  const handlers = new Map<string, Function>();
  const testPaths: PlatformPaths = {
    dotDir: ".omp",
    dotDirDisplay: ".omp",
    project: (_cwd: string, ...segments: string[]) => path.join(tmpDir, ...segments),
    global: (...segments: string[]) => path.join(tmpDir, "global", ...segments),
    agent: (...segments: string[]) => path.join(tmpDir, "agent", ...segments),
  };
  const platform = createMockPlatform({
    on: mock((event: string, handler: Function) => {
      handlers.set(event, handler);
    }) as any,
    paths: testPaths,
    registerTool: mock(),
    ...overrides,
  });
  return Object.assign(platform, {
    logger: { warn: mock(), error: mock(), debug: mock() },
    _handlers: handlers,
  }) as any;
}

function withLLM(opts: { enabled: boolean; threshold: number }): SupipowersConfig {
  // Tests scale compressionThreshold below llmThreshold so the synthetic
  // ~600-byte resume snapshot reaches the LLM path inside
  // compressToolResultWithLLM (which gates on `byteSize > compressionThreshold`
  // before invoking the summarize callback).
  const compressionThreshold = Math.max(64, Math.floor(opts.threshold / 4));
  return {
    ...DEFAULT_CONFIG,
    contextMode: {
      ...DEFAULT_CONFIG.contextMode,
      compressionThreshold,
      llmSummarization: opts.enabled,
      llmThreshold: opts.threshold,
    },
  };
}

function seedLargeSnapshot(): void {
  const sessionId = getSessionId();
  const eventStore = getEventStore();
  expect(eventStore).not.toBeNull();
  // Snapshot builder summarizes files by path, so we need many distinct paths
  // to push the snapshot above the test llmThreshold (256 bytes). Five file
  // events plus surrounding XML scaffolding produces ~600+ bytes.
  const bigText = "x".repeat(64);
  for (let i = 0; i < 5; i++) {
    eventStore!.writeEvent({
      sessionId,
      category: "file",
      data: JSON.stringify({ op: "edit", path: `src/big-${i}.ts`, content: bigText }),
      priority: 2,
      source: "test",
      timestamp: Date.now() + i,
    });
  }
}

function registerTracked(platform: any, config: SupipowersConfig): void {
  registerContextModeHooks(platform, config);
  activeShutdown = () => {
    const shutdown = platform._handlers?.get("session_shutdown");
    if (typeof shutdown === "function") shutdown({}, {});
    else getEventStore()?.close();
    _resetCache();
  };
}

function makeSession(opts: {
  finalText: string | null;
  promptShouldThrow?: boolean;
  promptShouldHang?: boolean;
}) {
  const promptMock = mock(async (_text: string, _o?: any): Promise<void> => {
    if (opts.promptShouldThrow) throw new Error("prompt failed");
    if (opts.promptShouldHang) await new Promise(() => {}); // never resolves
  });
  const messages: any[] = opts.finalText
    ? [{ role: "assistant", content: opts.finalText }]
    : [];
  const session: any = {
    subscribe: mock(() => () => {}),
    prompt: promptMock,
    state: { messages },
    dispose: mock(async () => {}),
  };
  return { session, promptMock };
}

describe("session_before_compact LLM summarization wiring", () => {
  beforeEach(() => {
    _resetCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-llm-compact-"));
  });

  afterEach(() => {
    try {
      activeShutdown?.();
    } finally {
      activeShutdown = null;
      _resetCache();
      rmDirWithRetry(tmpDir);
    }
  });

  test("llmSummarization=false: summarize callback never invoked, deterministic snapshot persisted", async () => {
    const createAgentSession = mock(async () => makeSession({ finalText: "summary" }).session);
    const platform = createPlatformWithTmpPaths({ createAgentSession: createAgentSession as any });
    registerTracked(platform, withLLM({ enabled: false, threshold: 128 }));
    platform._handlers.get("session_start")({}, { cwd: tmpDir });
    seedLargeSnapshot();

    await platform._handlers.get("session_before_compact")();

    expect(createAgentSession).not.toHaveBeenCalled();
    const sessionId = getSessionId();
    const resume = getEventStore()!.getResume(sessionId);
    expect(resume).not.toBeNull();
    // Deterministic snapshot, not "summary"
    expect(resume!.snapshot).not.toBe("summary");
    expect(resume!.snapshot.length).toBeGreaterThan(50);
  });

  test("llmSummarization=true but snapshot below threshold: no summarization", async () => {
    const createAgentSession = mock(async () => makeSession({ finalText: "summary" }).session);
    const platform = createPlatformWithTmpPaths({ createAgentSession: createAgentSession as any });
    // Threshold ~ 1MB so the small synthetic snapshot stays below it.
    registerTracked(platform, withLLM({ enabled: true, threshold: 1024 * 1024 }));
    platform._handlers.get("session_start")({}, { cwd: tmpDir });
    seedLargeSnapshot();

    await platform._handlers.get("session_before_compact")();

    expect(createAgentSession).not.toHaveBeenCalled();
    const resume = getEventStore()!.getResume(getSessionId());
    expect(resume).not.toBeNull();
    expect(resume!.snapshot).not.toBe("summary");
  });

  test("llmSummarization=true and snapshot >= threshold: summarize called once, resume row updated", async () => {
    const summary = "x".repeat(120) + " summarized snapshot text";
    const createAgentSession = mock(async () => makeSession({ finalText: summary }).session);
    const platform = createPlatformWithTmpPaths({ createAgentSession: createAgentSession as any });
    // Force a main-session model so resolveModelForAction returns a model.
    platform.getCurrentModel = mock(() => "test-model");
    registerTracked(platform, withLLM({ enabled: true, threshold: 128 }));
    platform._handlers.get("session_start")({}, { cwd: tmpDir });
    seedLargeSnapshot();

    await platform._handlers.get("session_before_compact")();

    expect(createAgentSession).toHaveBeenCalledTimes(1);
    const resume = getEventStore()!.getResume(getSessionId());
    expect(resume).not.toBeNull();
    expect(resume!.snapshot).toBe(summary);
  });

  test("summarize prompt throws: deterministic snapshot remains", async () => {
    const { session } = makeSession({ finalText: null, promptShouldThrow: true });
    const createAgentSession = mock(async () => session);
    const platform = createPlatformWithTmpPaths({ createAgentSession: createAgentSession as any });
    platform.getCurrentModel = mock(() => "test-model");
    registerTracked(platform, withLLM({ enabled: true, threshold: 128 }));
    platform._handlers.get("session_start")({}, { cwd: tmpDir });
    seedLargeSnapshot();

    await platform._handlers.get("session_before_compact")();

    const resume = getEventStore()!.getResume(getSessionId());
    expect(resume).not.toBeNull();
    // Deterministic snapshot is preserved, not the summary.
    expect(resume!.snapshot).not.toContain("summarized");
    expect(resume!.snapshot.length).toBeGreaterThan(50);
  });

  test("createAgentSession unavailable (throws): deterministic snapshot remains", async () => {
    const createAgentSession = mock(async () => {
      throw new Error("no agent session API");
    });
    const platform = createPlatformWithTmpPaths({ createAgentSession: createAgentSession as any });
    platform.getCurrentModel = mock(() => "test-model");
    registerTracked(platform, withLLM({ enabled: true, threshold: 128 }));
    platform._handlers.get("session_start")({}, { cwd: tmpDir });
    seedLargeSnapshot();

    await platform._handlers.get("session_before_compact")();

    const resume = getEventStore()!.getResume(getSessionId());
    expect(resume).not.toBeNull();
    expect(resume!.snapshot.length).toBeGreaterThan(50);
  });

  test("summary too short (<50 chars): falls back per compressToolResultWithLLM semantics — deterministic snapshot remains", async () => {
    const tooShort = "ok"; // far below the 50-char floor in compressToolResultWithLLM
    const createAgentSession = mock(async () => makeSession({ finalText: tooShort }).session);
    const platform = createPlatformWithTmpPaths({ createAgentSession: createAgentSession as any });
    platform.getCurrentModel = mock(() => "test-model");
    registerTracked(platform, withLLM({ enabled: true, threshold: 128 }));
    platform._handlers.get("session_start")({}, { cwd: tmpDir });
    seedLargeSnapshot();

    await platform._handlers.get("session_before_compact")();

    const resume = getEventStore()!.getResume(getSessionId());
    expect(resume).not.toBeNull();
    expect(resume!.snapshot).not.toBe(tooShort);
    expect(resume!.snapshot.length).toBeGreaterThan(50);
  });

  test("no model resolves (no main, no role, no override): summarize never invoked", async () => {
    const createAgentSession = mock(async () => makeSession({ finalText: "x".repeat(80) }).session);
    const platform = createPlatformWithTmpPaths({ createAgentSession: createAgentSession as any });
    // No getCurrentModel and no getModelForRole -> resolution falls through to "main"
    // with model=undefined -> our helper skips the LLM step entirely.
    platform.getCurrentModel = mock(() => "unknown");
    platform.getModelForRole = mock(() => null);
    registerTracked(platform, withLLM({ enabled: true, threshold: 128 }));
    platform._handlers.get("session_start")({}, { cwd: tmpDir });
    seedLargeSnapshot();

    await platform._handlers.get("session_before_compact")();

    expect(createAgentSession).not.toHaveBeenCalled();
    const resume = getEventStore()!.getResume(getSessionId());
    expect(resume).not.toBeNull();
    expect(resume!.snapshot.length).toBeGreaterThan(50);
  });
});
