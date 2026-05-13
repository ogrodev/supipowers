import { afterEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { _resetCache } from "../../src/context-mode/hooks.js";
import { MetricsStore, __setMetricsStoreForTest } from "../../src/context-mode/metrics-store.js";
import { createMockPlatform } from "../../src/platform/test-utils.js";
import type { SupipowersConfig } from "../../src/types.js";
import { registerActiveToolController } from "../../src/tool-catalog/active-tool-controller.js";
import { rmDirWithRetry } from "../helpers/fs.js";

function createPlatformWithHandlers(overrides: Record<string, unknown> = {}) {
  const handlers = new Map<string, Function>();
  const platform = createMockPlatform({
    getActiveTools: mock(() => ["bash", "ctx_execute"]),
    getAllTools: mock(() => [
      "bash",
      "ctx_execute",
      "ctx_search",
      "ctx_open_cached",
      "ctx_batch_execute",
      "ctx_fetch_and_index",
    ]),
    setActiveTools: mock(async () => {}),
    on: mock((event: string, handler: Function) => {
      handlers.set(event, handler);
    }) as any,
    ...overrides,
  });

  return Object.assign(platform, {
    _handlers: handlers,
    logger: { warn: mock(), error: mock(), debug: mock() },
  }) as any;
}

function lazyToolsConfig(overrides: Partial<SupipowersConfig["contextMode"]["lazyTools"]> = {}): SupipowersConfig {
  return {
    ...DEFAULT_CONFIG,
    contextMode: {
      ...DEFAULT_CONFIG.contextMode,
      lazyTools: {
        ...DEFAULT_CONFIG.contextMode.lazyTools,
        ...overrides,
      },
    },
  };
}

afterEach(() => {
  __setMetricsStoreForTest(null);
  _resetCache();
});

describe("registerActiveToolController degraded mode", () => {
  test("does not register when lazy tools are disabled", () => {
    const platform = createPlatformWithHandlers();

    registerActiveToolController(platform, lazyToolsConfig({ enabled: false }));

    expect(platform.on).not.toHaveBeenCalled();
  });

  test("does not register when context-mode is disabled", () => {
    const platform = createPlatformWithHandlers();
    registerActiveToolController(
      platform,
      {
        ...DEFAULT_CONFIG,
        contextMode: { ...DEFAULT_CONFIG.contextMode, enabled: false },
      },
    );

    expect(platform.on).not.toHaveBeenCalled();
  });

  test("returns undefined and does not mutate when getAllTools is unavailable", async () => {
    const platform = createPlatformWithHandlers({ getAllTools: undefined });
    registerActiveToolController(platform, DEFAULT_CONFIG);

    const handler = platform._handlers.get("before_agent_start");
    expect(handler).toBeDefined();
    const result = await handler({ prompt: "search repo", systemPrompt: ["before"] }, {
      cwd: "/tmp/project",
      getSystemPrompt: mock(() => ["after"]),
    });

    expect(result).toBeUndefined();
    expect(platform.setActiveTools).not.toHaveBeenCalled();
  });

  test("returns undefined and does not mutate when setActiveTools is unavailable", async () => {
    const platform = createPlatformWithHandlers({ setActiveTools: undefined });
    registerActiveToolController(platform, DEFAULT_CONFIG);

    const handler = platform._handlers.get("before_agent_start");
    const result = await handler({ prompt: "search repo", systemPrompt: ["before"] }, {
      cwd: "/tmp/project",
      getSystemPrompt: mock(() => ["after"]),
    });

    expect(result).toBeUndefined();
    expect(platform.setActiveTools).toBeUndefined();
  });

  test("returns undefined and does not mutate when getSystemPrompt is unavailable", async () => {
    const platform = createPlatformWithHandlers();
    registerActiveToolController(platform, DEFAULT_CONFIG);

    const handler = platform._handlers.get("before_agent_start");
    const result = await handler({ prompt: "search repo", systemPrompt: ["before"] }, {
      cwd: "/tmp/project",
    });

    expect(result).toBeUndefined();
    expect(platform.setActiveTools).not.toHaveBeenCalled();
  });
});

describe("registerActiveToolController mutation flow", () => {
  test("awaits setActiveTools before returning the rebuilt system prompt", async () => {
    const calls: string[] = [];
    const platform = createPlatformWithHandlers({
      setActiveTools: mock(async () => {
        calls.push("set:start");
        await Promise.resolve();
        calls.push("set:end");
      }),
    });
    const getSystemPrompt = mock(() => {
      calls.push("prompt");
      return ["rebuilt prompt"];
    });

    registerActiveToolController(platform, DEFAULT_CONFIG);

    const handler = platform._handlers.get("before_agent_start");
    const result = await handler({ prompt: "search repo", systemPrompt: ["original prompt"] }, {
      cwd: "/tmp/project",
      getSystemPrompt,
    });

    expect(platform.setActiveTools).toHaveBeenCalledWith([
      "bash",
      "ctx_execute",
      "ctx_search",
      "ctx_open_cached",
      "ctx_batch_execute",
    ]);
    expect(calls).toEqual(["set:start", "set:end", "prompt"]);
    expect(result).toEqual({ systemPrompt: ["rebuilt prompt"] });
  });

  test("does not rebuild the prompt when the planned tool list is unchanged", async () => {
    const platform = createPlatformWithHandlers({
      getActiveTools: mock(() => ["bash", "ctx_execute", "ctx_search", "ctx_open_cached"]),
    });
    const getSystemPrompt = mock(() => ["rebuilt prompt"]);

    registerActiveToolController(platform, DEFAULT_CONFIG);

    const handler = platform._handlers.get("before_agent_start");
    const result = await handler({ prompt: "edit file", systemPrompt: ["original prompt"] }, {
      cwd: "/tmp/project",
      getSystemPrompt,
    });

    expect(platform.setActiveTools).not.toHaveBeenCalled();
    expect(getSystemPrompt).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  test("preserves original prompt when setActiveTools rejects", async () => {
    const platform = createPlatformWithHandlers({
      setActiveTools: mock(async () => {
        throw new Error("mutation failed");
      }),
    });
    const getSystemPrompt = mock(() => ["rebuilt prompt"]);

    registerActiveToolController(platform, DEFAULT_CONFIG);

    const handler = platform._handlers.get("before_agent_start");
    const result = await handler({ prompt: "search repo", systemPrompt: ["original prompt"] }, {
      cwd: "/tmp/project",
      getSystemPrompt,
    });

    expect(result).toEqual({ systemPrompt: ["original prompt"] });
    expect(getSystemPrompt).not.toHaveBeenCalled();
    expect(platform.logger.warn).toHaveBeenCalled();
  });

  test("hides native search/find/fetch when ctx replacements are active and enforceRouting is on", async () => {
    const platform = createPlatformWithHandlers({
      getActiveTools: mock(() => [
        "bash",
        "search",
        "find",
        "fetch",
        "web_fetch",
        "ctx_execute",
      ]),
      getAllTools: mock(() => [
        "bash",
        "search",
        "find",
        "fetch",
        "web_fetch",
        "ctx_execute",
        "ctx_search",
        "ctx_batch_execute",
        "ctx_fetch_and_index",
        "ctx_open_cached",
      ]),
    });
    const getSystemPrompt = mock(() => ["rebuilt prompt"]);

    registerActiveToolController(platform, DEFAULT_CONFIG);

    const handler = platform._handlers.get("before_agent_start");
    await handler({ prompt: "search repo and fetch http docs", systemPrompt: ["original prompt"] }, {
      cwd: "/tmp/project",
      getSystemPrompt,
    });

    const passed = platform.setActiveTools.mock.calls[0][0] as string[];
    expect(passed).not.toContain("search");
    expect(passed).not.toContain("find");
    expect(passed).not.toContain("fetch");
    expect(passed).not.toContain("web_fetch");
    expect(passed).toContain("bash");
    expect(passed).toContain("ctx_execute");
    expect(passed).toContain("ctx_search");
    expect(passed).toContain("ctx_fetch_and_index");
  });

  test("does not hide native tools when enforceRouting is disabled", async () => {
    const platform = createPlatformWithHandlers({
      getActiveTools: mock(() => ["bash", "search", "find", "ctx_execute"]),
      getAllTools: mock(() => [
        "bash",
        "search",
        "find",
        "ctx_execute",
        "ctx_search",
        "ctx_batch_execute",
        "ctx_open_cached",
      ]),
    });
    const getSystemPrompt = mock(() => ["rebuilt prompt"]);

    const config: SupipowersConfig = {
      ...DEFAULT_CONFIG,
      contextMode: { ...DEFAULT_CONFIG.contextMode, enforceRouting: false },
    };
    registerActiveToolController(platform, config);

    const handler = platform._handlers.get("before_agent_start");
    await handler({ prompt: "search repo", systemPrompt: ["original prompt"] }, {
      cwd: "/tmp/project",
      getSystemPrompt,
    });

    const passed = platform.setActiveTools.mock.calls[0]?.[0] as string[] | undefined;
    if (passed) {
      expect(passed).toContain("search");
      expect(passed).toContain("find");
    }
  });
});

describe("registerActiveToolController metrics", () => {
  test("records one L7 lazy-tools metrics row after successful filtering", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-lazy-tools-metrics-"));
    const dbPath = path.join(tmpDir, "metrics.db");
    const store = new MetricsStore({ dbPath, projectSlug: "test-project" });
    store.init();
    __setMetricsStoreForTest(store);

    try {
      const platform = createPlatformWithHandlers();
      registerActiveToolController(platform, DEFAULT_CONFIG);

      const handler = platform._handlers.get("before_agent_start");
      await handler({ prompt: "search repo", systemPrompt: ["original prompt"] }, {
        cwd: tmpDir,
        getSystemPrompt: mock(() => ["rebuilt prompt"]),
        getContextUsage: mock(() => ({ tokens: 123, contextWindow: 1000, percent: 12.3 })),
      });
      await store.flushPendingForTest();

      const db = new Database(dbPath, { readonly: true });
      try {
        const rows = db.prepare(
          `SELECT layer, tool, processor, before_bytes, after_bytes, cache_hit, unique_source_hash, context_tokens, context_window, context_percent
             FROM metrics`,
        ).all() as Array<Record<string, unknown>>;

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          layer: "L7",
          tool: "(system)",
          processor: "lazy-tools",
          before_bytes: new TextEncoder().encode("original prompt").byteLength,
          after_bytes: new TextEncoder().encode("rebuilt prompt").byteLength,
          cache_hit: 0,
          context_tokens: 123,
          context_window: 1000,
          context_percent: 12.3,
        });
        expect(rows[0].unique_source_hash).toEqual(expect.any(String));
        expect(JSON.stringify(rows)).not.toContain("search repo");
      } finally {
        db.close();
      }
    } finally {
      store.close();
      __setMetricsStoreForTest(null);
      rmDirWithRetry(tmpDir);
    }
  }, process.platform === "win32" ? 20_000 : undefined);
});
