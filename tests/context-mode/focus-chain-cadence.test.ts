// tests/context-mode/focus-chain-cadence.test.ts
//
// Phase A of the token-saving followups: focus-chain reinjection at
// `before_agent_start` is now cadence-gated by `contextMode.memory.focusChainCadence`.
// Turn 1 always injects; subsequent turns inject only when
// `turnCount % cadence === 0`. Resetting via session_start re-arms turn 1.

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

function createPlatformWithTmpPaths() {
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
  });
  return Object.assign(platform, {
    logger: { warn: mock(), error: mock(), debug: mock() },
    _handlers: handlers,
  }) as any;
}

function configWithCadence(cadence: number): SupipowersConfig {
  return {
    ...DEFAULT_CONFIG,
    contextMode: {
      ...DEFAULT_CONFIG.contextMode,
      memory: {
        ...DEFAULT_CONFIG.contextMode.memory,
        focusChainCadence: cadence,
      },
    },
  };
}

function seedTaskEvent(sessionId: string): void {
  const eventStore = getEventStore();
  expect(eventStore).not.toBeNull();
  eventStore!.writeEvent({
    sessionId,
    category: "task",
    data: JSON.stringify({
      input: {
        ops: [
          { op: "start", task: "wire focus chain cadence" },
        ],
      },
    }),
    priority: 2,
    source: "test",
    timestamp: Date.now(),
  });
}

function callBeforeAgentStart(platform: any): string {
  const handler = platform._handlers.get("before_agent_start");
  expect(typeof handler).toBe("function");
  const result = handler({ prompt: "", systemPrompt: ["existing-prompt"] }, { cwd: tmpDir });
  const prompt = result?.systemPrompt;
  return Array.isArray(prompt) ? prompt.join("\n\n") : (prompt ?? "");
}

function registerHooksTracked(platform: any, config: SupipowersConfig): void {
  registerContextModeHooks(platform, config);
  activeShutdown = () => {
    const shutdown = platform._handlers?.get("session_shutdown");
    if (typeof shutdown === "function") {
      shutdown({}, {});
      return;
    }
    getEventStore()?.close();
    _resetCache();
  };
}

describe("focus-chain cadence gating", () => {
  beforeEach(() => {
    _resetCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-focus-chain-"));
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

  test("cadence=6: turn 1 injects, turns 2-5 skip, turn 6 injects, turn 7 skips, turn 12 injects", () => {
    const platform = createPlatformWithTmpPaths();
    registerHooksTracked(platform, configWithCadence(6));
    platform._handlers.get("session_start")({}, { cwd: tmpDir });
    seedTaskEvent(getSessionId());
    platform.getActiveTools.mockReturnValue(["ctx_execute", "ctx_search"]);

    const turn1 = callBeforeAgentStart(platform);
    expect(turn1).toContain("# Focus chain");

    for (let turn = 2; turn <= 5; turn++) {
      const prompt = callBeforeAgentStart(platform);
      expect(prompt).not.toContain("# Focus chain");
    }

    const turn6 = callBeforeAgentStart(platform);
    expect(turn6).toContain("# Focus chain");

    const turn7 = callBeforeAgentStart(platform);
    expect(turn7).not.toContain("# Focus chain");

    // Turns 8-11 skip
    for (let turn = 8; turn <= 11; turn++) {
      const prompt = callBeforeAgentStart(platform);
      expect(prompt).not.toContain("# Focus chain");
    }

    const turn12 = callBeforeAgentStart(platform);
    expect(turn12).toContain("# Focus chain");
  });

  test("cadence=1: every turn injects (preserves pre-cadence behavior)", () => {
    const platform = createPlatformWithTmpPaths();
    registerHooksTracked(platform, configWithCadence(1));
    platform._handlers.get("session_start")({}, { cwd: tmpDir });
    seedTaskEvent(getSessionId());
    platform.getActiveTools.mockReturnValue(["ctx_execute", "ctx_search"]);

    for (let turn = 1; turn <= 5; turn++) {
      const prompt = callBeforeAgentStart(platform);
      expect(prompt).toContain("# Focus chain");
    }
  });

  test("cadence=3: turns 1, 3, 6, 9 inject; 2, 4, 5, 7, 8 skip", () => {
    const platform = createPlatformWithTmpPaths();
    registerHooksTracked(platform, configWithCadence(3));
    platform._handlers.get("session_start")({}, { cwd: tmpDir });
    seedTaskEvent(getSessionId());
    platform.getActiveTools.mockReturnValue(["ctx_execute", "ctx_search"]);

    const expectedInject = new Set<number>([1, 3, 6, 9]);
    for (let turn = 1; turn <= 9; turn++) {
      const prompt = callBeforeAgentStart(platform);
      if (expectedInject.has(turn)) {
        expect(prompt).toContain("# Focus chain");
      } else {
        expect(prompt).not.toContain("# Focus chain");
      }
    }
  });

  test("session_start re-arms turn 1 (resets the cadence counter)", () => {
    const platform = createPlatformWithTmpPaths();
    registerHooksTracked(platform, configWithCadence(6));
    platform._handlers.get("session_start")({}, { cwd: tmpDir });
    seedTaskEvent(getSessionId());
    platform.getActiveTools.mockReturnValue(["ctx_execute", "ctx_search"]);

    // Burn turns 1..5 — turn 1 injects, turns 2..5 skip.
    expect(callBeforeAgentStart(platform)).toContain("# Focus chain");
    for (let turn = 2; turn <= 5; turn++) {
      expect(callBeforeAgentStart(platform)).not.toContain("# Focus chain");
    }

    // Re-emit session_start: counter resets, the next call is turn 1 again.
    platform._handlers.get("session_start")({}, { cwd: tmpDir });
    seedTaskEvent(getSessionId());
    expect(callBeforeAgentStart(platform)).toContain("# Focus chain");
  });

  test("no event store: focus chain is null regardless of cadence", () => {
    const platform = createPlatformWithTmpPaths();
    const config: SupipowersConfig = {
      ...configWithCadence(1),
      contextMode: {
        ...configWithCadence(1).contextMode,
        eventTracking: false,
      },
    };
    registerHooksTracked(platform, config);
    platform._handlers.get("session_start")({}, { cwd: tmpDir });
    platform.getActiveTools.mockReturnValue(["ctx_execute"]);

    for (let turn = 1; turn <= 3; turn++) {
      const prompt = callBeforeAgentStart(platform);
      expect(prompt).not.toContain("# Focus chain");
    }
  });

  test("empty event store: focus chain is null even on turn 1", () => {
    const platform = createPlatformWithTmpPaths();
    registerHooksTracked(platform, configWithCadence(1));
    platform._handlers.get("session_start")({}, { cwd: tmpDir });
    // No seedTaskEvent — event store is initialized but empty.
    platform.getActiveTools.mockReturnValue(["ctx_execute", "ctx_search"]);

    const prompt = callBeforeAgentStart(platform);
    expect(prompt).not.toContain("# Focus chain");
  });
});
