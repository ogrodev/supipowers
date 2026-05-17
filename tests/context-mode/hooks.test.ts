// tests/context-mode/hooks.test.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { rmDirWithRetry } from "../helpers/fs.js";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";

import { registerContextModeHooks, _resetCache, getCacheStore, getEventStore, getKnowledgeStore, getMetricsStore, getSessionId } from "../../src/context-mode/hooks.js";
import { getMemoryStore } from "../../src/context-mode/memory-store.js";
import { getProjectStatePath } from "../../src/workspace/state-paths.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type { SupipowersConfig } from "../../src/types.js";
import { createMockPlatform } from "../../src/platform/test-utils.js";
import type { PlatformPaths } from "../../src/platform/types.js";

// All places that use `createMockPlatformWithHandlers` directly read/write into
// per-project sqlite databases (events.db, metrics.db, cache.db, memory.db).
// Without an isolated path the suite would leak state into the developer's real
// `~/.omp/supipowers/projects/<slug>/sessions/*` directory, breaking test
// isolation across runs (regression: F5 promotion now writes project-scoped
// rows that survive across sessions).
function createMockPlatformWithHandlers() {
  const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-hooks-iso-"));
  isolatedDirsToCleanup.push(isolatedDir);
  return createMockPlatformWithHandlersAndPaths(isolatedDir);
}

function createMockPlatformWithHandlersAndPaths(rootDir: string) {
  const handlers = new Map<string, Function>();
  const testPaths: PlatformPaths = {
    dotDir: ".omp",
    dotDirDisplay: ".omp",
    project: (_cwd: string, ...segments: string[]) => path.join(rootDir, "project", ...segments),
    global: (...segments: string[]) => path.join(rootDir, "global", ...segments),
    agent: (...segments: string[]) => path.join(rootDir, "agent", ...segments),
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

function largeBashEvent(command = "ls") {
  const bigOutput = Array.from({ length: 500 }, (_, i) => `line ${i}: ${"x".repeat(20)}`).join("\n");
  return {
    type: "tool_result",
    toolName: "bash",
    toolCallId: "test-id",
    input: { command },
    content: [{ type: "text", text: bigOutput }],
    isError: false,
    details: { exitCode: 0 },
  };
}


function promptText(result: any): string {
  const value = result?.systemPrompt;
  return Array.isArray(value) ? value.join("\n\n") : (value ?? "");
}

const isolatedDirsToCleanup: string[] = [];

function cleanupIsolatedTestDirs(): void {
  while (isolatedDirsToCleanup.length > 0) {
    const dir = isolatedDirsToCleanup.pop();
    if (!dir) continue;
    try { rmDirWithRetry(dir); } catch { /* best effort */ }
  }
}
let activeSessionShutdown: (() => void) | null = null;

function registerTrackedContextModeHooks(platform: any, config: SupipowersConfig): void {
  registerContextModeHooks(platform, config);
  activeSessionShutdown = () => {
    const shutdown = platform._handlers?.get("session_shutdown");
    if (typeof shutdown === "function") {
      shutdown({}, {});
      return;
    }
    getEventStore()?.close();
    _resetCache();
  };
}

function cleanupTrackedContextModeHooks(): void {
  try {
    activeSessionShutdown?.();
  } finally {
    activeSessionShutdown = null;
    _resetCache();
    cleanupIsolatedTestDirs();
  }
}

describe("registerContextModeHooks", () => {
  beforeEach(() => {
    _resetCache();
  });

  afterEach(() => {
    cleanupTrackedContextModeHooks();
  });

  test("registers hooks when enabled", () => {
    const platform = createMockPlatformWithHandlers();
    registerTrackedContextModeHooks(platform, DEFAULT_CONFIG);
    expect(platform.on).toHaveBeenCalledWith("tool_result", expect.any(Function));
    expect(platform.on).toHaveBeenCalledWith("tool_call", expect.any(Function));
    expect(platform.on).toHaveBeenCalledWith("before_agent_start", expect.any(Function));
    expect(platform.on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(platform.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
  });

  test("registers native context-mode tools", () => {
    const platform = createMockPlatformWithHandlers();
    registerTrackedContextModeHooks(platform, DEFAULT_CONFIG);
    // 11 native tools should be registered
    expect(platform.registerTool).toHaveBeenCalledTimes(11);
  });

  test("omits store-dependent ctx tools when knowledge store initialization fails", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "supi-hooks-no-knowledge-"));
    isolatedDirsToCleanup.push(root);
    fs.writeFileSync(path.join(root, "global"), "not a directory");
    const platform = createMockPlatformWithHandlersAndPaths(root);

    registerTrackedContextModeHooks(platform, DEFAULT_CONFIG);

    const names = (platform.registerTool as any).mock.calls.map((call: any[]) => call[0].name);
    expect(names).toContain("ctx_execute");
    expect(names).toContain("ctx_open_cached");
    expect(names).not.toContain("ctx_search");
    expect(names).not.toContain("ctx_index");
    expect(names).not.toContain("ctx_batch_execute");
    expect(names).not.toContain("ctx_fetch_and_index");
    expect(names).not.toContain("ctx_purge");
  });


  test("rebinds knowledge store when active session cwd changes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "supi-hooks-cwd-"));
    isolatedDirsToCleanup.push(root);
    const platform = createMockPlatformWithHandlersAndPaths(root);
    const cwdA = path.join(root, "repo-a");
    const cwdB = path.join(root, "repo-b");
    fs.mkdirSync(cwdA, { recursive: true });
    fs.mkdirSync(cwdB, { recursive: true });

    registerTrackedContextModeHooks(platform, DEFAULT_CONFIG);
    const sessionStart = platform._handlers.get("session_start");
    expect(typeof sessionStart).toBe("function");

    sessionStart({}, { cwd: cwdA });
    const firstPath = getKnowledgeStore()?.path;
    expect(firstPath).toBe(getProjectStatePath(platform.paths, cwdA, "sessions", "knowledge.db"));

    sessionStart({}, { cwd: cwdB });
    const secondPath = getKnowledgeStore()?.path;
    expect(secondPath).toBe(getProjectStatePath(platform.paths, cwdB, "sessions", "knowledge.db"));
    expect(secondPath).not.toBe(firstPath);
  });
  test("does not register hooks when disabled", () => {
    const platform = createMockPlatformWithHandlers();
    const config: SupipowersConfig = {
      ...DEFAULT_CONFIG,
      contextMode: { ...DEFAULT_CONFIG.contextMode, enabled: false },
    };
    registerTrackedContextModeHooks(platform, config);
    expect(platform.on).not.toHaveBeenCalled();
  });

  test("tool_result handler compresses large bash output", () => {
    const platform = createMockPlatformWithHandlers();
    registerTrackedContextModeHooks(platform, DEFAULT_CONFIG);

    const handler = platform._handlers.get("tool_result");
    expect(handler).toBeDefined();

    const bigOutput = Array.from({ length: 500 }, (_, i) => `line ${i}: ${'x'.repeat(20)}`).join("\n");
    const event = {
      type: "tool_result",
      toolName: "bash",
      toolCallId: "test-id",
      input: { command: "ls" },
      content: [{ type: "text", text: bigOutput }],
      isError: false,
      details: { exitCode: 0 },
    };

    const result = handler(event, {});
    expect(result).toBeDefined();
    expect(result.content[0].text).toContain("[...compressed:");
  });

  test("tool_result handler passes through small output", () => {
    const platform = createMockPlatformWithHandlers();
    registerTrackedContextModeHooks(platform, DEFAULT_CONFIG);

    const handler = platform._handlers.get("tool_result");
    const event = {
      type: "tool_result",
      toolName: "bash",
      toolCallId: "test-id",
      input: { command: "echo hi" },
      content: [{ type: "text", text: "hi" }],
      isError: false,
      details: { exitCode: 0 },
    };

    const result = handler(event, {});
    expect(result).toBeUndefined();
  });

  test("tool_call handler blocks curl when context-mode detected", () => {
    const platform = createMockPlatformWithHandlers();
    platform.getActiveTools.mockReturnValue(["bash", "ctx_fetch_and_index"]);
    registerTrackedContextModeHooks(platform, DEFAULT_CONFIG);

    const handler = platform._handlers.get("tool_call");
    const event = {
      type: "tool_call",
      toolName: "bash",
      toolCallId: "test-id",
      input: { command: "curl https://example.com/api" },
    };

    const result = handler(event, {});
    expect(result).toBeDefined();
    expect(result.block).toBe(true);
    expect(result.reason).toContain("ctx_fetch_and_index");
  });

  test("tool_call handler allows curl when ctx_fetch_and_index is inactive", () => {
    const platform = createMockPlatformWithHandlers();
    platform.getActiveTools.mockReturnValue(["bash", "read"]);
    registerTrackedContextModeHooks(platform, DEFAULT_CONFIG);

    const handler = platform._handlers.get("tool_call");
    const event = {
      type: "tool_call",
      toolName: "bash",
      toolCallId: "test-id",
      input: { command: "curl https://example.com/api" },
    };

    const result = handler(event, {});
    expect(result).toBeUndefined();
  });

  test("tool_call handler passes through non-HTTP bash commands", () => {
    const platform = createMockPlatformWithHandlers();
    platform.getActiveTools.mockReturnValue(["bash", "ctx_fetch_and_index"]);
    registerTrackedContextModeHooks(platform, DEFAULT_CONFIG);

    const handler = platform._handlers.get("tool_call");
    const event = {
      type: "tool_call",
      toolName: "bash",
      toolCallId: "test-id",
      input: { command: "ls -la" },
    };

    const result = handler(event, {});
    expect(result).toBeUndefined();
  }, process.platform === "win32" ? 60_000 : undefined);

  test("before_agent_start handler concatenates routing when context-mode detected", () => {
    const platform = createMockPlatformWithHandlers();
    platform.getActiveTools.mockReturnValue(["bash", "ctx_execute", "ctx_search"]);
    registerTrackedContextModeHooks(platform, DEFAULT_CONFIG);

    const handler = platform._handlers.get("before_agent_start");
    expect(handler).toBeDefined();

    const event = { prompt: "fix the bug", systemPrompt: ["You are an assistant."] };
    const result = handler(event, {});
    expect(result).toBeDefined();
    const prompt = promptText(result);
    expect(prompt).toContain("You are an assistant.");
    expect(prompt).toContain("context-mode");
    expect(prompt).toContain("Active context-mode rescue tools: ctx_execute, ctx_search");
    expect(prompt).toContain("prefer active `ctx_search` over Search/Find outputs");
    expect(prompt).not.toContain("`ctx_search` or `ctx_batch_execute`");
    expect(prompt).not.toContain("ctx_purge");
    const injected = prompt.replace("You are an assistant.\n\n", "");
    expect(new TextEncoder().encode(injected).byteLength).toBeLessThanOrEqual(2048);
  }, process.platform === "win32" ? 60_000 : undefined);

  test("before_agent_start handler appends routing to current rebuilt system prompt", () => {
    const platform = createMockPlatformWithHandlers();
    platform.getActiveTools.mockReturnValue(["bash", "ctx_execute", "ctx_search"]);
    registerTrackedContextModeHooks(platform, DEFAULT_CONFIG);

    const handler = platform._handlers.get("before_agent_start");
    const event = { prompt: "fix the bug", systemPrompt: ["stale prompt"] };
    const result = handler(event, { getSystemPrompt: mock(() => ["rebuilt prompt"]) });

    expect(result).toBeDefined();
    const prompt = promptText(result);
    expect(prompt).toContain("rebuilt prompt");
    expect(prompt).not.toContain("stale prompt");
    expect(prompt).toContain("context-mode");
  });

  test("before_agent_start handler is no-op when routing disabled", () => {
    const platform = createMockPlatformWithHandlers();
    platform.getActiveTools.mockReturnValue(["bash", "read"]);
    const config: SupipowersConfig = {
      ...DEFAULT_CONFIG,
      contextMode: { ...DEFAULT_CONFIG.contextMode, routingInstructions: false, enforceRouting: false },
    };
    registerTrackedContextModeHooks(platform, config);

    const handler = platform._handlers.get("before_agent_start");
    const event = { prompt: "fix the bug", systemPrompt: ["You are an assistant."] };
    const result = handler(event, {});
    expect(result).toBeUndefined();
  });

  test("tool_result handler extracts events without throwing (fire-and-forget)", () => {
    const platform = createMockPlatformWithHandlers();
    registerTrackedContextModeHooks(platform, DEFAULT_CONFIG);

    const handler = platform._handlers.get("tool_result");
    const event = {
      type: "tool_result",
      toolName: "read",
      toolCallId: "test-id",
      input: { path: "/src/test.ts" },
      content: [{ type: "text", text: "content" }],
      isError: false,
      details: undefined,
    };

    // Handler should not throw even without event store initialized
    expect(() => handler(event, {})).not.toThrow();
  });

  test("tool_result handler routes canonical 'open' tool name like 'read'", () => {
    const platform = createMockPlatformWithHandlers();
    registerTrackedContextModeHooks(platform, DEFAULT_CONFIG);

    const handler = platform._handlers.get("tool_result");
    const event = {
      type: "tool_result",
      toolName: "open",
      toolCallId: "test-id",
      input: { path: "/src/test.ts" },
      content: [{ type: "text", text: "content" }],
      isError: false,
      details: undefined,
    };

    expect(() => handler(event, {})).not.toThrow();
  });

  test("tool_result deduplicates repeated same-source large bash output and records final processor", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-hooks-dedup-"));
    try {
      const platform = createMockPlatformWithHandlersAndPaths(tmpDir);
      registerTrackedContextModeHooks(platform, DEFAULT_CONFIG);
      platform._handlers.get("session_start")({}, { cwd: tmpDir });

      const handler = platform._handlers.get("tool_result");
      const first = handler(largeBashEvent("ls"), {});
      const second = handler(largeBashEvent("ls"), {});

      expect(first.content[0].text).toContain("[...compressed:");
      expect(second.content[0].text).toContain("same as turn 1");
      expect(second.content[0].text).toContain("processor=bash");

      const store = getMetricsStore();
      expect(store).not.toBeNull();
      await store!.flushPendingForTest();

      const probe = new Database(store!.dbPath);
      try {
        const rows = probe
          .prepare(`SELECT processor, unique_source_hash FROM metrics ORDER BY id ASC`)
          .all() as Array<{ processor: string; unique_source_hash: string | null }>;
        expect(rows.map((row) => row.processor)).toEqual(["bash", "dedup"]);
        expect(rows[0].unique_source_hash).not.toBeNull();
        expect(rows[1].unique_source_hash).toBe(rows[0].unique_source_hash);
      } finally {
        probe.close();
      }
    } finally {
      cleanupTrackedContextModeHooks();
      rmDirWithRetry(tmpDir);
    }
  });

  test("large git status records git processor metrics", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-hooks-git-"));
    try {
      const platform = createMockPlatformWithHandlersAndPaths(tmpDir);
      registerTrackedContextModeHooks(platform, DEFAULT_CONFIG);
      platform._handlers.get("session_start")({}, { cwd: tmpDir });

      const gitStatus = [
        "## feature/l2-processors...origin/feature/l2-processors [ahead 2]",
        ...Array.from({ length: 260 }, (_, i) => ` M src/context-mode/file-${i}.ts`),
      ].join("\n");
      const handler = platform._handlers.get("tool_result");
      handler({
        type: "tool_result",
        toolName: "bash",
        toolCallId: "test-id",
        input: { command: "git status --short --branch" },
        content: [{ type: "text", text: gitStatus }],
        isError: false,
        details: { exitCode: 0 },
      }, {});

      const store = getMetricsStore();
      expect(store).not.toBeNull();
      await store!.flushPendingForTest();

      const probe = new Database(store!.dbPath);
      try {
        const row = probe
          .prepare(`SELECT processor FROM metrics ORDER BY id DESC LIMIT 1`)
          .get() as { processor: string };
        expect(row.processor).toBe("git");
      } finally {
        probe.close();
      }
    } finally {
      cleanupTrackedContextModeHooks();
      rmDirWithRetry(tmpDir);
    }
  });

  test("session_shutdown clears dedup state", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-hooks-dedup-"));
    try {
      const platform = createMockPlatformWithHandlersAndPaths(tmpDir);
      registerTrackedContextModeHooks(platform, DEFAULT_CONFIG);
      const sessionStart = platform._handlers.get("session_start");
      const shutdown = platform._handlers.get("session_shutdown");
      const handler = platform._handlers.get("tool_result");

      sessionStart({}, { cwd: tmpDir });
      handler(largeBashEvent("ls"), {});
      expect(handler(largeBashEvent("ls"), {}).content[0].text).toContain("same as turn 1");

      shutdown({}, {});
      sessionStart({}, { cwd: tmpDir });
      const afterRestart = handler(largeBashEvent("ls"), {});
      expect(afterRestart.content[0].text).not.toContain("dedup");
      expect(afterRestart.content[0].text).toContain("[...compressed:");
    } finally {
      cleanupTrackedContextModeHooks();
      rmDirWithRetry(tmpDir);
    }
  });

  test("registers compaction hooks when compaction enabled", () => {
    const platform = createMockPlatformWithHandlers();
    registerTrackedContextModeHooks(platform, DEFAULT_CONFIG);
    const events = platform.on.mock.calls.map((c: any[]) => c[0]);
    expect(events).toContain("session_before_compact");
    expect(events).toContain("session_compact");
  });

  test("does not register compaction hooks when disabled", () => {
    const platform = createMockPlatformWithHandlers();
    const config = {
      ...DEFAULT_CONFIG,
      contextMode: { ...DEFAULT_CONFIG.contextMode, compaction: false },
    };
    registerTrackedContextModeHooks(platform, config);
    const events = platform.on.mock.calls.map((c: any[]) => c[0]);
    expect(events).not.toContain("session_before_compact");
    expect(events).not.toContain("session_compact");
  });
});

describe("compaction integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    _resetCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-hooks-"));
  });

  afterEach(() => {
    cleanupTrackedContextModeHooks();
    rmDirWithRetry(tmpDir);
  });

  function createPlatformWithRealStore() {
    const handlers = new Map<string, Function>();
    // Custom paths that resolve to tmpDir regardless of cwd
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

  test("session_before_compact returns undefined (does not cancel compaction)", async () => {
    const platform = createPlatformWithRealStore();
    registerTrackedContextModeHooks(platform, DEFAULT_CONFIG);

    // Write some events through tool_result handler
    const toolHandler = platform._handlers.get("tool_result");
    toolHandler({
      toolName: "read",
      toolCallId: "id",
      input: { path: "/src/test.ts" },
      content: [{ type: "text", text: "content" }],
      isError: false,
      details: undefined,
    }, {});

    const handler = platform._handlers.get("session_before_compact");
    const result = await handler();
    expect(result).toBeUndefined();
  });

  test("session_compact returns snapshot with context and preserveData", () => {
    const platform = createPlatformWithRealStore();
    registerTrackedContextModeHooks(platform, DEFAULT_CONFIG);

    // Write events to populate the store
    const toolHandler = platform._handlers.get("tool_result");
    toolHandler({
      toolName: "edit",
      toolCallId: "id",
      input: { path: "/src/types.ts" },
      content: [{ type: "text", text: "edited" }],
      isError: false,
      details: undefined,
    }, {});

    // Build snapshot
    platform._handlers.get("session_before_compact")();

    // Consume snapshot
    const result = platform._handlers.get("session_compact")();
    expect(result).toBeDefined();
    expect(result.context).toBeInstanceOf(Array);
    expect(result.context.length).toBeGreaterThan(0);
    expect(result.preserveData).toBeDefined();
    expect(result.preserveData.resumeSnapshot).toContain("session_knowledge");
    expect(result.preserveData.eventCounts).toBeDefined();
  });

  test("session_compact returns undefined when no snapshot was built", () => {
    const platform = createPlatformWithRealStore();
    registerTrackedContextModeHooks(platform, DEFAULT_CONFIG);

    // Call compact without calling before_compact first
    const result = platform._handlers.get("session_compact")();
    // With DB-based resume, there's nothing to consume
    expect(result).toBeUndefined();
  });

  test("compact count increments after each compaction", () => {
    const platform = createPlatformWithRealStore();
    registerTrackedContextModeHooks(platform, DEFAULT_CONFIG);

    // Write an event so snapshot is non-empty
    const toolHandler = platform._handlers.get("tool_result");
    toolHandler({
      toolName: "edit",
      toolCallId: "id",
      input: { path: "/src/test.ts" },
      content: [{ type: "text", text: "content" }],
      isError: false,
      details: undefined,
    }, {});

    // First compaction
    platform._handlers.get("session_before_compact")();
    const r1 = platform._handlers.get("session_compact")();
    expect(r1).toBeDefined();

    // Second compaction (write another event first so snapshot is non-empty)
    toolHandler({
      toolName: "write",
      toolCallId: "id2",
      input: { path: "/src/new.ts" },
      content: [{ type: "text", text: "new" }],
      isError: false,
      details: undefined,
    }, {});
    platform._handlers.get("session_before_compact")();
    const r2 = platform._handlers.get("session_compact")();
    expect(r2).toBeDefined();
  });

  test("searchAvailable passed to snapshot when ctx_search detected", () => {
    const platform = createPlatformWithRealStore();
    platform.getActiveTools.mockReturnValue(["bash", "ctx_search", "ctx_execute"]);
    registerTrackedContextModeHooks(platform, DEFAULT_CONFIG);

    // Write an event
    const toolHandler = platform._handlers.get("tool_result");
    toolHandler({
      toolName: "edit",
      toolCallId: "id",
      input: { path: "/src/test.ts" },
      content: [{ type: "text", text: "content" }],
      isError: false,
      details: undefined,
    }, {});

    // Build + consume snapshot
    platform._handlers.get("session_before_compact")();
    const result = platform._handlers.get("session_compact")();
    expect(result).toBeDefined();
    // When searchAvailable, snapshot uses reference format with how_to_search
    expect(result.preserveData.resumeSnapshot).toContain("how_to_search");
  }, process.platform === "win32" ? 60_000 : undefined);
});


// ─────────────────────────────────────────────────────────────
// exported helpers
// ─────────────────────────────────────────────────────────────
describe("exported helpers", () => {
  let tmpDir: string;

  beforeEach(() => {
    _resetCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-hooks-helpers-"));
  });

  afterEach(() => {
    cleanupTrackedContextModeHooks();
    rmDirWithRetry(tmpDir);
  });

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

  test("getEventStore returns null before registration", () => {
    _resetCache();
    expect(getEventStore()).toBeNull();
  });

  test("getEventStore returns non-null store after registration", () => {
    const platform = createPlatformWithTmpPaths();
    registerTrackedContextModeHooks(platform, DEFAULT_CONFIG);
    expect(getEventStore()).not.toBeNull();
  });

  test("getSessionId returns empty string before registration", () => {
    _resetCache();
    expect(getSessionId()).toBe("");
  });

  test("getSessionId returns a session ID matching session-<digits> after registration", () => {
    const platform = createPlatformWithTmpPaths();
    registerTrackedContextModeHooks(platform, DEFAULT_CONFIG);
    expect(getSessionId()).toMatch(/^session-\d+$/);
  });

  test("session_start prefers a stable session-file hash when available", () => {
    const platform = createPlatformWithTmpPaths();
    registerTrackedContextModeHooks(platform, DEFAULT_CONFIG);

    const handler = platform._handlers.get("session_start");
    expect(handler).toBeDefined();

    handler({}, {
      cwd: "/tmp/project",
      sessionManager: {
        getSessionFile: () => "/tmp/project/.omp/sessions/active-session.json",
      },
    });

    expect(getSessionId()).toMatch(/^[0-9a-f]{16}$/);
  }, process.platform === "win32" ? 60_000 : undefined);

  test("_resetCache clears event store and session id", () => {
    const platform = createPlatformWithTmpPaths();
    registerTrackedContextModeHooks(platform, DEFAULT_CONFIG);
    expect(getEventStore()).not.toBeNull();
    expect(getSessionId()).not.toBe("");
    _resetCache();
    expect(getEventStore()).toBeNull();
    expect(getSessionId()).toBe("");
  });

  test("session_shutdown clears exported state", () => {
    const platform = createPlatformWithTmpPaths();
    registerTrackedContextModeHooks(platform, DEFAULT_CONFIG);
    expect(getEventStore()).not.toBeNull();
    expect(getSessionId()).not.toBe("");

    const handler = platform._handlers.get("session_shutdown");
    expect(handler).toBeDefined();
    handler({}, {});

    expect(getEventStore()).toBeNull();
    expect(getSessionId()).toBe("");
  });

  test("session_start initializes cache store under the sessions state path", () => {
    const platform = createPlatformWithTmpPaths();
    registerTrackedContextModeHooks(platform, DEFAULT_CONFIG);

    const handler = platform._handlers.get("session_start");
    expect(handler).toBeDefined();
    handler({}, { cwd: tmpDir });

    const cache = getCacheStore();
    expect(cache).not.toBeNull();
    expect(cache!.dbPath).toContain(path.join("projects"));
    expect(cache!.dbPath).toEndWith(path.join("sessions", "cache.db"));
    expect(cache!.payloadRoot).toEndWith(path.join("sessions", "cache-payloads"));
    expect(fs.existsSync(cache!.dbPath)).toBe(true);
  });

  test("session_shutdown prunes old cache refs, closes the store, and clears the exported ref", () => {
    const platform = createPlatformWithTmpPaths();
    registerTrackedContextModeHooks(platform, DEFAULT_CONFIG);

    const sessionStart = platform._handlers.get("session_start");
    sessionStart({}, { cwd: tmpDir });

    const cache = getCacheStore();
    expect(cache).not.toBeNull();
    const dbPath = cache!.dbPath;
    const payloadRoot = cache!.payloadRoot;
    cache!.putText({ sessionId: "old", text: "old cache payload", sourceTool: "read", sourceHash: "old", now: 0 });

    const shutdown = platform._handlers.get("session_shutdown");
    expect(shutdown).toBeDefined();
    shutdown({}, {});

    expect(getCacheStore()).toBeNull();

    const reopened = new Database(dbPath, { readonly: true });
    try {
      const refs = reopened.prepare(`SELECT COUNT(*) AS count FROM cache_refs`).get() as { count: number };
      const entries = reopened.prepare(`SELECT COUNT(*) AS count FROM cache_entries`).get() as { count: number };
      expect(refs.count).toBe(0);
      expect(entries.count).toBe(0);
    } finally {
      reopened.close();
    }
    expect(fs.existsSync(payloadRoot)).toBe(true);
  });

  test("_resetCache clears cache store ref", () => {
    const platform = createPlatformWithTmpPaths();
    registerTrackedContextModeHooks(platform, DEFAULT_CONFIG);
    expect(getCacheStore()).not.toBeNull();

    _resetCache();

    expect(getCacheStore()).toBeNull();
  });

  test("large tool_result output remains an L2 compression result, not a cache handle", () => {
    const platform = createPlatformWithTmpPaths();
    registerTrackedContextModeHooks(platform, DEFAULT_CONFIG);
    platform._handlers.get("session_start")({}, { cwd: tmpDir });

    const handler = platform._handlers.get("tool_result");
    const result = handler(largeBashEvent(), { cwd: tmpDir });

    expect(result).toBeDefined();
    expect(result.content[0].text).toContain("[...compressed:");
    expect(result.content[0].text).not.toContain("cache://");
  });

  test("spills oversized final text emissions into cache handles", () => {
    const platform = createPlatformWithTmpPaths();
    registerTrackedContextModeHooks(platform, DEFAULT_CONFIG);
    platform._handlers.get("session_start")({}, { cwd: tmpDir });

    const originalText = `important header\n${"x".repeat(70 * 1024)}\nimportant tail`;
    const handler = platform._handlers.get("tool_result");
    const result = handler({
      type: "tool_result",
      toolName: "custom_big",
      toolCallId: "spill-id",
      input: { id: "spill" },
      content: [{ type: "text", text: originalText }],
      isError: false,
      details: {},
    }, { cwd: tmpDir });

    expect(result).toBeDefined();
    const text = result.content[0].text;
    expect(text).toContain("Cached oversized custom_big result as cache://");
    expect(text).toContain("ctx_open_cached");
    expect(text).toContain("--- preview ---");
    expect(text.length).toBeLessThan(originalText.length);
    const handle = text.match(/cache:\/\/[a-f0-9]{64}/)?.[0];
    expect(handle).toBeDefined();
    const opened = getCacheStore()!.openText(handle!);
    expect(opened.ok).toBe(true);
    if (opened.ok) expect(opened.text).toBe(originalText);
  });

  test("does not spill OMP-minimized output with raw artifact footer", () => {
    const platform = createPlatformWithTmpPaths();
    registerTrackedContextModeHooks(platform, DEFAULT_CONFIG);
    platform._handlers.get("session_start")({}, { cwd: tmpDir });

    const minimized = `${"x".repeat(70 * 1024)}\n[raw output: artifact://abc123]`;
    const handler = platform._handlers.get("tool_result");
    const result = handler({
      type: "tool_result",
      toolName: "bash",
      toolCallId: "minimized-id",
      input: { command: "echo large" },
      content: [{ type: "text", text: minimized }],
      isError: false,
      details: { exitCode: 0 },
    }, { cwd: tmpDir });

    expect(result).toBeUndefined();
  });

  test("before_agent_start injects bounded cross-session memory blocks", () => {
    const platform = createPlatformWithTmpPaths();
    registerTrackedContextModeHooks(platform, {
      ...DEFAULT_CONFIG,
      mempalace: { ...DEFAULT_CONFIG.mempalace, enabled: false },
    });
    platform._handlers.get("session_start")({}, { cwd: tmpDir });

    const sessionId = getSessionId();
    const memory = getMemoryStore()!;
    expect(memory).not.toBeNull();
    memory.put({ ownerScope: "session", ownerId: sessionId, type: "decision", body: "prefer dedup over masking" });
    memory.put({ ownerScope: "project", type: "observation", body: "primary cwd is /repo" });

    platform.getActiveTools.mockReturnValue(["ctx_execute", "ctx_search"]);
    const handler = platform._handlers.get("before_agent_start");
    const result = handler({ prompt: "", systemPrompt: ["existing prompt"] }, { cwd: tmpDir });

    expect(result).toBeDefined();
    const prompt = promptText(result);
    expect(prompt).toContain("existing prompt");
    expect(prompt).toContain("# Cross-session memory");
    expect(prompt).toContain("prefer dedup over masking");
    expect(prompt).toContain("primary cwd is /repo");
  });

  test("before_agent_start suppresses memory after /supi:clear session epoch", () => {
    const platform = createPlatformWithTmpPaths();
    registerTrackedContextModeHooks(platform, {
      ...DEFAULT_CONFIG,
      mempalace: { ...DEFAULT_CONFIG.mempalace, enabled: false },
    });
    platform._handlers.get("session_start")({}, { cwd: tmpDir });

    const sessionId = getSessionId();
    const memory = getMemoryStore()!;
    memory.put({ ownerScope: "project", type: "observation", body: "old project memory", now: 1000 });
    memory.put({ ownerScope: "session", ownerId: sessionId, type: "decision", body: "old session memory", now: 1000 });
    memory.clearSession(sessionId, 5000);
    memory.put({ ownerScope: "project", type: "observation", body: "fresh project memory", now: 9000 });

    platform.getActiveTools.mockReturnValue(["ctx_execute", "ctx_search"]);
    const handler = platform._handlers.get("before_agent_start");
    const result = handler({ prompt: "", systemPrompt: ["existing"] }, { cwd: tmpDir });

    const prompt = promptText(result);
    expect(prompt).toContain("fresh project memory");
    expect(prompt).not.toContain("old project memory");
    expect(prompt).not.toContain("old session memory");
  });

  test("before_agent_start emits focus chain block when task events exist", () => {
    const platform = createPlatformWithTmpPaths();
    registerTrackedContextModeHooks(platform, DEFAULT_CONFIG);
    platform._handlers.get("session_start")({}, { cwd: tmpDir });

    const sessionId = getSessionId();
    const eventStore = getEventStore();
    expect(eventStore).not.toBeNull();
    eventStore!.writeEvent({
      sessionId,
      category: "task",
      data: JSON.stringify({
        input: {
          ops: [
            { op: "start", task: "audit ctx_repomap" },
            { op: "done", phase: "L4 Repo Map" },
          ],
        },
      }),
      priority: 2,
      source: "test",
      timestamp: Date.now(),
    });

    platform.getActiveTools.mockReturnValue(["ctx_execute", "ctx_search"]);
    const handler = platform._handlers.get("before_agent_start");
    const result = handler({ prompt: "", systemPrompt: ["existing"] }, { cwd: tmpDir });
    const prompt = promptText(result);
    expect(prompt).toContain("# Focus chain");
    expect(prompt).toContain("start: audit ctx_repomap");
    expect(prompt).toContain("done: L4 Repo Map");
  }, process.platform === "win32" ? 60_000 : undefined);

  test("before_agent_start suppresses legacy memory when MemPalace is enabled but keeps focus chain", () => {
    const platform = createPlatformWithTmpPaths();
    registerTrackedContextModeHooks(platform, DEFAULT_CONFIG);
    platform._handlers.get("session_start")({}, { cwd: tmpDir });

    const sessionId = getSessionId();
    const memory = getMemoryStore()!;
    memory.put({ ownerScope: "session", ownerId: sessionId, type: "decision", body: "legacy memory should not inject" });
    const eventStore = getEventStore()!;
    eventStore.writeEvent({
      sessionId,
      category: "task",
      data: JSON.stringify({ input: { ops: [{ op: "start", task: "keep focus chain" }] } }),
      priority: 2,
      source: "test",
      timestamp: Date.now(),
    });

    platform.getActiveTools.mockReturnValue(["ctx_execute", "ctx_search"]);
    const result = platform._handlers.get("before_agent_start")({ prompt: "", systemPrompt: ["existing"] }, { cwd: tmpDir });

    const prompt = promptText(result);
    expect(prompt).not.toContain("# Cross-session memory");
    expect(prompt).not.toContain("legacy memory should not inject");
    expect(prompt).toContain("# Focus chain");
    expect(prompt).toContain("keep focus chain");
  });

  test("session_before_compact prepends compact.md override into the resume snapshot", () => {
    const platform = createPlatformWithTmpPaths();
    registerTrackedContextModeHooks(platform, DEFAULT_CONFIG);
    platform._handlers.get("session_start")({}, { cwd: tmpDir });

    const sessionId = getSessionId();
    const eventStore = getEventStore();
    eventStore!.writeEvent({
      sessionId,
      category: "file",
      data: JSON.stringify({ op: "edit", path: "src/foo.ts" }),
      priority: 2,
      source: "test",
      timestamp: Date.now(),
    });

    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "compact.md"), "## Project compact rules\n\nKeep test fixtures terse.");

    platform.getActiveTools.mockReturnValue(["ctx_execute", "ctx_search"]);
    const beforeCompact = platform._handlers.get("session_before_compact");
    expect(beforeCompact).toBeDefined();
    beforeCompact({}, {});

    const compactHandler = platform._handlers.get("session_compact");
    const result = compactHandler({}, {}) as { context?: string[] };
    const text = (result?.context ?? []).join("\n");
    expect(text).toContain("## Project compact rules");
    expect(text).toContain("<files ");
    expect(text).toContain("src/foo.ts");
  });

  test("session_before_compact ignores oversized compact.md override", () => {
    const platform = createPlatformWithTmpPaths();
    registerTrackedContextModeHooks(platform, DEFAULT_CONFIG);
    platform._handlers.get("session_start")({}, { cwd: tmpDir });

    const sessionId = getSessionId();
    const eventStore = getEventStore();
    eventStore!.writeEvent({
      sessionId,
      category: "file",
      data: JSON.stringify({ op: "edit", path: "src/foo.ts" }),
      priority: 2,
      source: "test",
      timestamp: Date.now(),
    });

    fs.mkdirSync(tmpDir, { recursive: true });
    const oversize = "x".repeat(50 * 1024);
    fs.writeFileSync(path.join(tmpDir, "compact.md"), oversize);

    const beforeCompact = platform._handlers.get("session_before_compact");
    beforeCompact({}, {});
    const compactHandler = platform._handlers.get("session_compact");
    const result = compactHandler({}, {}) as { context?: string[] };
    const text = (result?.context ?? []).join("\n");
    expect(text).not.toContain(oversize);
    expect(text).toContain("src/foo.ts");
  });
});

// ─────────────────────────────────────────────────────────────
// error handling
// ─────────────────────────────────────────────────────────────
describe("error handling", () => {
  let tmpDir: string;

  beforeEach(() => {
    _resetCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-hooks-errors-"));
  });

  afterEach(() => {
    cleanupTrackedContextModeHooks();
    rmDirWithRetry(tmpDir);
  });

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

  test("tool_result handler continues when event extraction throws", () => {
    const platform = createPlatformWithTmpPaths();
    registerTrackedContextModeHooks(platform, DEFAULT_CONFIG);

    // Close the underlying store so writeEvents throws inside the try-block.
    getEventStore()?.close();

    const handler = platform._handlers.get("tool_result");
    // Big bash output with a git command: compressor compresses (exitCode 0, >threshold),
    // extractEvents emits a git event, writeEvents is called on the closed DB and throws.
    const bigOutput = Array.from({ length: 500 }, (_, i) => `line ${i}: ${"x".repeat(20)}`).join("\n");
    const event = {
      type: "tool_result",
      toolName: "bash",
      toolCallId: "test-id",
      input: { command: "git commit -m 'test'" },
      content: [{ type: "text", text: bigOutput }],
      isError: false,
      details: { exitCode: 0 },
    };

    let result: any;
    expect(() => { result = handler(event, {}); }).not.toThrow();
    // Compression must still run (big bash, exitCode 0)
    expect(result).toBeDefined();
    expect(result.content[0].text).toContain("[...compressed:");

    const warnCalls = (platform.logger.warn as any).mock.calls;
    expect(warnCalls.some((c: any[]) => String(c[0]).includes("event extraction failed"))).toBe(true);
  });

  test("before_agent_start handler continues when prompt extraction throws", () => {
    const platform = createPlatformWithTmpPaths();
    platform.getActiveTools.mockReturnValue(["bash", "ctx_execute", "ctx_search"]);
    registerTrackedContextModeHooks(platform, DEFAULT_CONFIG);

    // Close the store: extractPromptEvents always produces >= 1 event,
    // so writeEvents will be invoked on a closed DB and throw.
    getEventStore()?.close();

    const handler = platform._handlers.get("before_agent_start");
    const event = { prompt: "fix the bug", systemPrompt: ["You are an assistant."] };

    let result: any;
    expect(() => { result = handler(event, {}); }).not.toThrow();
    // Routing instructions still injected despite extraction failure
    expect(result).toBeDefined();
    const prompt = promptText(result);
    expect(prompt).toContain("You are an assistant.");
    expect(prompt).toContain("context-mode");

    const warnCalls = (platform.logger.warn as any).mock.calls;
    expect(warnCalls.some((c: any[]) => String(c[0]).includes("prompt event extraction failed"))).toBe(true);
  }, process.platform === "win32" ? 60_000 : undefined);

  test("compaction hooks not registered when eventTracking is false", () => {
    const platform = createPlatformWithTmpPaths();
    const config: SupipowersConfig = {
      ...DEFAULT_CONFIG,
      contextMode: {
        ...DEFAULT_CONFIG.contextMode,
        eventTracking: false,
        compaction: true,
      },
    };
    registerTrackedContextModeHooks(platform, config);

    const events = platform.on.mock.calls.map((c: any[]) => c[0]);
    expect(events).not.toContain("session_before_compact");
    expect(events).not.toContain("session_compact");
  });

  test("session_before_compact returns undefined on an empty session with no events", async () => {
    const platform = createPlatformWithTmpPaths();
    registerTrackedContextModeHooks(platform, DEFAULT_CONFIG);

    const handler = platform._handlers.get("session_before_compact");
    const result = await handler();
    expect(result).toBeUndefined();
  });

  test("session_compact returns undefined on a fresh session with no pending resume in the DB", () => {
    const platform = createPlatformWithTmpPaths();
    registerTrackedContextModeHooks(platform, DEFAULT_CONFIG);

    // Fresh session: no events written and no before_compact called — the
    // session_resume row should not exist.
    expect(getEventStore()?.getResume(getSessionId())).toBeNull();

    const result = platform._handlers.get("session_compact")();
    expect(result).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────
// tool_result with MCP tool names
// ─────────────────────────────────────────────────────────────
describe("tool_result with MCP tool names", () => {
  let tmpDir: string;

  beforeEach(() => {
    _resetCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-hooks-mcp-"));
  });

  afterEach(() => {
    cleanupTrackedContextModeHooks();
    rmDirWithRetry(tmpDir);
  });

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

  test("MCP-prefixed tool names pass through tool_result handler without throwing", () => {
    // Documents current behavior: extractEvents checks `toolName.startsWith("ctx_")`
    // for the mcp category. MCP-prefixed names like "mcp__context_mode_ctx_search"
    // do NOT start with "ctx_", so they fall through the default branch and no
    // events are emitted. The handler must still run without throwing, and no
    // extraction-failure warnings should be logged. If this behavior changes in
    // the future (e.g. recognizing mcp_*_ctx_* names), this test will fail loudly.
    const platform = createPlatformWithTmpPaths();
    registerTrackedContextModeHooks(platform, DEFAULT_CONFIG);

    const handler = platform._handlers.get("tool_result");
    const event = {
      type: "tool_result",
      toolName: "mcp__context_mode_ctx_search",
      toolCallId: "test-id",
      input: { queries: ["foo"] },
      content: [{ type: "text", text: "small result" }],
      isError: false,
      details: undefined,
    };

    let result: any = "unset";
    expect(() => { result = handler(event, {}); }).not.toThrow();
    // Small output → compressor returns undefined (pass-through)
    expect(result).toBeUndefined();

    const warnCalls = (platform.logger.warn as any).mock.calls;
    expect(warnCalls.some((c: any[]) => String(c[0]).includes("event extraction failed"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Memory promotion on session_shutdown (regression: F5)
// ---------------------------------------------------------------------------

describe("session_shutdown → memory promotion", () => {
  let promoTmp: string;

  beforeEach(() => {
    _resetCache();
    promoTmp = fs.mkdtempSync(path.join(os.tmpdir(), "supi-promo-"));
  });

  afterEach(() => {
    cleanupTrackedContextModeHooks();
    rmDirWithRetry(promoTmp);
  });

  test("promotes high-priority decision events as project-scoped memory so future sessions can see them", async () => {
    const { MemoryStore } = await import("../../src/context-mode/memory-store.js");
    const platform = createMockPlatformWithHandlersAndPaths(promoTmp);
    registerTrackedContextModeHooks(platform, DEFAULT_CONFIG);
    platform._handlers.get("session_start")({}, { cwd: promoTmp });

    const sessionId = getSessionId();
    const eventStore = getEventStore()!;
    const memoryStore = getMemoryStore()!;
    const memoryPath = memoryStore.dbPath;

    eventStore.writeEvent({
      sessionId,
      category: "decision",
      data: JSON.stringify({ prompt: "use TDD for retry tests" }),
      priority: 2,
      source: "test",
      timestamp: Date.now(),
    });

    // session_shutdown promotes decision/task/intent/rule events into memory.
    platform._handlers.get("session_shutdown")({}, {});

    // Reopen on the same path; the closed store cannot be reused.
    const reopened = new MemoryStore({ dbPath: memoryPath, projectSlug: "demo" });
    reopened.init();
    try {
      // A different sessionId simulates a future session retrieving cross-session memory.
      const rows = reopened.retrieve({ sessionId: "future-session-id" });
      const decisions = rows.filter((r) => r.type === "decision");
      expect(decisions.length).toBe(1);
      expect(decisions[0].body).toContain("use TDD for retry tests");
      expect(decisions[0].ownerScope).toBe("project");
    } finally {
      reopened.close();
    }
  }, process.platform === "win32" ? 60_000 : undefined);
});


// ---------------------------------------------------------------------------
// Slice-2 hook bridge wiring
// ---------------------------------------------------------------------------

describe("registerContextModeHooks — slice-2 hook-bridge integration", () => {
  beforeEach(() => { _resetCache(); });
  afterEach(() => { cleanupTrackedContextModeHooks(); });

  test("registers handlers for all six UltraPlan-relevant hooks (session_start, before_agent_start, tool_call, tool_result, agent_end, session_shutdown)", () => {
    const platform = createMockPlatformWithHandlers();
    registerTrackedContextModeHooks(platform, DEFAULT_CONFIG);

    // The context-mode hooks + the UltraPlan bridge together must cover all six events.
    expect(platform._handlers.has("session_start")).toBe(true);
    expect(platform._handlers.has("before_agent_start")).toBe(true);
    expect(platform._handlers.has("tool_call")).toBe(true);
    expect(platform._handlers.has("tool_result")).toBe(true);
    expect(platform._handlers.has("agent_end")).toBe(true);
    expect(platform._handlers.has("session_shutdown")).toBe(true);
  }, process.platform === "win32" ? 60_000 : undefined);

  test("src/context-mode/hooks.ts only imports from src/ultraplan/runtime/hook-bridge.ts within the UltraPlan runtime tree", () => {
    // Static import-surface assertion (delta spec §thin hook bridge rule).
    const repoRoot = process.cwd();
    const hooksSrc = fs.readFileSync(path.join(repoRoot, "src", "context-mode", "hooks.ts"), "utf8");
    const importRe = /from\s+["']([^"']+)["']/g;
    const offendingImports: string[] = [];
    for (const match of hooksSrc.matchAll(importRe)) {
      const specifier = match[1];
      if (!specifier.includes("/ultraplan/")) continue;
      if (specifier.endsWith("/ultraplan/runtime/hook-bridge.js")
        || specifier.endsWith("/ultraplan/runtime/hook-bridge")) {
        continue;
      }
      offendingImports.push(specifier);
    }
    expect(offendingImports).toEqual([]);
  });
});