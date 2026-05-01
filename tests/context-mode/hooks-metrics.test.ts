// tests/context-mode/hooks-metrics.test.ts
//
// Hook-level integration tests for the L1 metrics wiring (plan Tasks 20–25).
// Each test fires a synthetic event against an isolated mock platform whose
// paths are rooted in a tmpDir so the metrics.db lives under our control.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";

import {
  _resetCache,
  getCacheStore,
  getMetricsStore,
  registerContextModeHooks,
} from "../../src/context-mode/hooks.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type { SupipowersConfig } from "../../src/types.js";
import { createMockPlatform } from "../../src/platform/test-utils.js";
import type { PlatformPaths } from "../../src/platform/types.js";
import { rmDirWithRetry } from "../helpers/fs.js";

let tmpDir: string;

function createIsolatedPlatform() {
  const handlers = new Map<string, Function>();
  const testPaths: PlatformPaths = {
    dotDir: ".omp",
    dotDirDisplay: ".omp",
    project: (_cwd: string, ...segments: string[]) =>
      path.join(tmpDir, "project", ...segments),
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

function shutdownAll(platform: any): void {
  const shutdown = platform._handlers?.get("session_shutdown");
  if (typeof shutdown === "function") {
    try {
      shutdown({}, {});
    } catch {
      // Best effort.
    }
  }
  _resetCache();
}

beforeEach(() => {
  _resetCache();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-hooks-metrics-"));
});

afterEach(() => {
  rmDirWithRetry(tmpDir);
});

describe("registerContextModeHooks — metrics store wiring (Tasks 20, 21)", () => {
  test("session_start opens metrics.db and upserts session_meta_metrics (Task 20)", async () => {
    const platform = createIsolatedPlatform();
    registerContextModeHooks(platform, DEFAULT_CONFIG);

    const sessionStart = platform._handlers.get("session_start");
    expect(sessionStart).toBeDefined();

    sessionStart({}, { cwd: tmpDir });

    const store = getMetricsStore();
    expect(store).not.toBeNull();

    const probe = new Database(store!.dbPath);
    try {
      const meta = probe
        .prepare(
          `SELECT session_id, cwd, started_at FROM session_meta_metrics`,
        )
        .get() as { session_id: string; cwd: string; started_at: number };
      expect(meta.cwd).toBe(tmpDir);
      expect(meta.started_at).toBeGreaterThan(0);
      expect(typeof meta.session_id).toBe("string");
      expect(meta.session_id.length).toBeGreaterThan(0);
    } finally {
      probe.close();
    }

    shutdownAll(platform);
  });

  test("contextMode disabled prevents metrics-store init (Task 21)", () => {
    const platform = createIsolatedPlatform();
    const disabled: SupipowersConfig = {
      ...DEFAULT_CONFIG,
      contextMode: { ...DEFAULT_CONFIG.contextMode, enabled: false },
    };
    registerContextModeHooks(platform, disabled);

    expect(getMetricsStore()).toBeNull();
    expect(fs.existsSync(path.join(tmpDir, "global", "supipowers"))).toBe(false);
  });
});

describe("registerContextModeHooks — tool_result records metrics (Tasks 22, 23, 25)", () => {
  test("tool_result records a row after compression (Task 22)", async () => {
    const platform = createIsolatedPlatform();
    registerContextModeHooks(platform, DEFAULT_CONFIG);

    const sessionStart = platform._handlers.get("session_start");
    sessionStart({}, { cwd: tmpDir });

    const handler = platform._handlers.get("tool_result");
    expect(handler).toBeDefined();

    const bigOutput = Array.from({ length: 600 }, (_, i) => `line ${i}`).join("\n");
    handler(
      {
        type: "tool_result",
        toolName: "bash",
        toolCallId: "test-id",
        input: { command: "ls" },
        content: [{ type: "text", text: bigOutput }],
        isError: false,
        details: { exitCode: 0 },
      },
      { cwd: tmpDir },
    );

    const store = getMetricsStore();
    expect(store).not.toBeNull();
    await store!.flushPendingForTest();

    const probe = new Database(store!.dbPath);
    try {
      const row = probe
        .prepare(
          `SELECT tool, before_bytes, after_bytes FROM metrics ORDER BY id DESC LIMIT 1`,
        )
        .get() as { tool: string; before_bytes: number; after_bytes: number };
      expect(row.tool).toBe("bash");
      expect(row.before_bytes).toBeGreaterThan(0);
      expect(row.after_bytes).toBeLessThan(row.before_bytes);
    } finally {
      probe.close();
    }

    shutdownAll(platform);
  });

  test("tool_result returns the compressed content unchanged when recorder throws (Task 23)", async () => {
    const platform = createIsolatedPlatform();
    registerContextModeHooks(platform, DEFAULT_CONFIG);

    const sessionStart = platform._handlers.get("session_start");
    sessionStart({}, { cwd: tmpDir });

    const handler = platform._handlers.get("tool_result");
    const store = getMetricsStore()!;
    // Force an exception inside the metrics path by closing the store mid-flight.
    store.close();

    const bigOutput = Array.from({ length: 600 }, (_, i) => `line ${i}`).join("\n");
    let result: any = "unset";
    expect(() => {
      result = handler(
        {
          type: "tool_result",
          toolName: "bash",
          toolCallId: "test-id",
          input: { command: "ls" },
          content: [{ type: "text", text: bigOutput }],
          isError: false,
          details: { exitCode: 0 },
        },
        { cwd: tmpDir },
      );
    }).not.toThrow();

    // The compressor's verdict must still flow through to the agent.
    expect(result).toBeDefined();
    expect(result.content[0].text).toContain("[...compressed:");

    shutdownAll(platform);
  });

  test("tool_result with no contextUsage records null token columns (Task 25)", async () => {
    const platform = createIsolatedPlatform();
    registerContextModeHooks(platform, DEFAULT_CONFIG);

    const sessionStart = platform._handlers.get("session_start");
    sessionStart({}, { cwd: tmpDir });

    const handler = platform._handlers.get("tool_result");
    const bigOutput = Array.from({ length: 600 }, (_, i) => `line ${i}`).join("\n");
    handler(
      {
        type: "tool_result",
        toolName: "bash",
        toolCallId: "test-id",
        input: { command: "ls" },
        content: [{ type: "text", text: bigOutput }],
        isError: false,
        details: { exitCode: 0 },
        // No contextUsage field present.
      },
      { cwd: tmpDir },
    );

    const store = getMetricsStore()!;
    await store.flushPendingForTest();

    const probe = new Database(store.dbPath);
    try {
      const row = probe
        .prepare(
          `SELECT context_tokens, context_window, context_percent FROM metrics ORDER BY id DESC LIMIT 1`,
        )
        .get() as {
        context_tokens: number | null;
        context_window: number | null;
        context_percent: number | null;
      };
      expect(row.context_tokens).toBeNull();
      expect(row.context_window).toBeNull();
      expect(row.context_percent).toBeNull();
    } finally {
      probe.close();
    }

    shutdownAll(platform);
  });
});

describe("registerContextModeHooks — session_shutdown closes metrics store (Task 24)", () => {
  test("session_shutdown prunes and closes the metrics store; getMetricsStore() returns null after", () => {
    const platform = createIsolatedPlatform();
    registerContextModeHooks(platform, DEFAULT_CONFIG);

    const sessionStart = platform._handlers.get("session_start");
    sessionStart({}, { cwd: tmpDir });

    const beforeShutdown = getMetricsStore();
    expect(beforeShutdown).not.toBeNull();
    const dbPath = beforeShutdown!.dbPath;
    expect(fs.existsSync(dbPath)).toBe(true);

    const shutdown = platform._handlers.get("session_shutdown");
    expect(shutdown).toBeDefined();
    shutdown({}, {});

    expect(getMetricsStore()).toBeNull();

    // Verify last_prune_at was set on the project meta row.
    const probe = new Database(dbPath);
    try {
      const project = probe
        .prepare(`SELECT last_prune_at FROM project_meta_metrics LIMIT 1`)
        .get() as { last_prune_at: number } | undefined;
      expect(project).not.toBeUndefined();
      expect(project!.last_prune_at).toBeGreaterThan(0);
    } finally {
      probe.close();
    }
  });
});

describe("registerContextModeHooks — L3 cache metrics", () => {
  test("session_shutdown records cache-prune rows before closing metrics", async () => {
    const platform = createIsolatedPlatform();
    registerContextModeHooks(platform, DEFAULT_CONFIG);

    const sessionStart = platform._handlers.get("session_start");
    sessionStart({}, { cwd: tmpDir });

    const metrics = getMetricsStore();
    const cache = getCacheStore();
    expect(metrics).not.toBeNull();
    expect(cache).not.toBeNull();
    const metricsDb = metrics!.dbPath;
    cache!.putText({ sessionId: "old", text: "old cache metrics", sourceTool: "read", sourceHash: "old", now: 0 });
    await metrics!.flushPendingForTest();

    const shutdown = platform._handlers.get("session_shutdown");
    shutdown({}, {});

    const probe = new Database(metricsDb);
    try {
      const row = probe.prepare(`SELECT layer, processor, cache_hit FROM metrics WHERE processor = 'cache-prune'`).get() as {
        layer: string;
        processor: string;
        cache_hit: number;
      } | undefined;
      expect(row).toEqual({ layer: "L3", processor: "cache-prune", cache_hit: 0 });
    } finally {
      probe.close();
    }
  });
});
