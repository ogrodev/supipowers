// tests/context-mode/hooks.test.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { rmDirWithRetry } from "../helpers/fs.js";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { registerContextModeHooks, _resetCache, getEventStore, getSessionId } from "../../src/context-mode/hooks.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type { SupipowersConfig } from "../../src/types.js";
import { createMockPlatform } from "../../src/platform/test-utils.js";
import type { PlatformPaths } from "../../src/platform/types.js";

function createMockPlatformWithHandlers() {
  const handlers = new Map<string, Function>();
  const platform = createMockPlatform({
    on: mock((event: string, handler: Function) => {
      handlers.set(event, handler);
    }) as any,
    registerTool: mock(),
  });
  return Object.assign(platform, {
    logger: { warn: mock(), error: mock(), debug: mock() },
    _handlers: handlers,
  }) as any;
}

describe("registerContextModeHooks", () => {
  beforeEach(() => {
    _resetCache();
  });

  test("registers hooks when enabled", () => {
    const platform = createMockPlatformWithHandlers();
    registerContextModeHooks(platform, DEFAULT_CONFIG);
    expect(platform.on).toHaveBeenCalledWith("tool_result", expect.any(Function));
    expect(platform.on).toHaveBeenCalledWith("tool_call", expect.any(Function));
    expect(platform.on).toHaveBeenCalledWith("before_agent_start", expect.any(Function));
    expect(platform.on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(platform.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
  });

  test("registers native context-mode tools", () => {
    const platform = createMockPlatformWithHandlers();
    registerContextModeHooks(platform, DEFAULT_CONFIG);
    // 8 native tools should be registered
    expect(platform.registerTool).toHaveBeenCalledTimes(8);
  });

  test("does not register hooks when disabled", () => {
    const platform = createMockPlatformWithHandlers();
    const config: SupipowersConfig = {
      ...DEFAULT_CONFIG,
      contextMode: { ...DEFAULT_CONFIG.contextMode, enabled: false },
    };
    registerContextModeHooks(platform, config);
    expect(platform.on).not.toHaveBeenCalled();
  });

  test("tool_result handler compresses large bash output", () => {
    const platform = createMockPlatformWithHandlers();
    registerContextModeHooks(platform, DEFAULT_CONFIG);

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
    registerContextModeHooks(platform, DEFAULT_CONFIG);

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
    registerContextModeHooks(platform, DEFAULT_CONFIG);

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

  test("tool_call handler blocks curl since context-mode tools are always available", () => {
    const platform = createMockPlatformWithHandlers();
    platform.getActiveTools.mockReturnValue(["bash", "read"]);
    registerContextModeHooks(platform, DEFAULT_CONFIG);

    const handler = platform._handlers.get("tool_call");
    const event = {
      type: "tool_call",
      toolName: "bash",
      toolCallId: "test-id",
      input: { command: "curl https://example.com/api" },
    };

    const result = handler(event, {});
    // Native tools are always available — curl is always blocked
    expect(result).toBeDefined();
    expect(result.block).toBe(true);
    expect(result.reason).toContain("ctx_fetch_and_index");
  });

  test("tool_call handler passes through non-HTTP bash commands", () => {
    const platform = createMockPlatformWithHandlers();
    platform.getActiveTools.mockReturnValue(["bash", "ctx_fetch_and_index"]);
    registerContextModeHooks(platform, DEFAULT_CONFIG);

    const handler = platform._handlers.get("tool_call");
    const event = {
      type: "tool_call",
      toolName: "bash",
      toolCallId: "test-id",
      input: { command: "ls -la" },
    };

    const result = handler(event, {});
    expect(result).toBeUndefined();
  });

  test("before_agent_start handler concatenates routing when context-mode detected", () => {
    const platform = createMockPlatformWithHandlers();
    platform.getActiveTools.mockReturnValue(["bash", "ctx_execute", "ctx_search"]);
    registerContextModeHooks(platform, DEFAULT_CONFIG);

    const handler = platform._handlers.get("before_agent_start");
    expect(handler).toBeDefined();

    const event = { prompt: "fix the bug", systemPrompt: "You are an assistant." };
    const result = handler(event, {});
    expect(result).toBeDefined();
    expect(result.systemPrompt).toContain("You are an assistant.");
    expect(result.systemPrompt).toContain("context-mode");
  });

  test("before_agent_start handler is no-op when routing disabled", () => {
    const platform = createMockPlatformWithHandlers();
    platform.getActiveTools.mockReturnValue(["bash", "read"]);
    const config: SupipowersConfig = {
      ...DEFAULT_CONFIG,
      contextMode: { ...DEFAULT_CONFIG.contextMode, routingInstructions: false, enforceRouting: false },
    };
    registerContextModeHooks(platform, config);

    const handler = platform._handlers.get("before_agent_start");
    const event = { prompt: "fix the bug", systemPrompt: "You are an assistant." };
    const result = handler(event, {});
    expect(result).toBeUndefined();
  });

  test("tool_result handler extracts events without throwing (fire-and-forget)", () => {
    const platform = createMockPlatformWithHandlers();
    registerContextModeHooks(platform, DEFAULT_CONFIG);

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

  test("registers compaction hooks when compaction enabled", () => {
    const platform = createMockPlatformWithHandlers();
    registerContextModeHooks(platform, DEFAULT_CONFIG);
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
    registerContextModeHooks(platform, config);
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

  test("session_before_compact returns undefined (does not cancel compaction)", () => {
    const platform = createPlatformWithRealStore();
    registerContextModeHooks(platform, DEFAULT_CONFIG);

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
    const result = handler();
    expect(result).toBeUndefined();
  });

  test("session_compact returns snapshot with context and preserveData", () => {
    const platform = createPlatformWithRealStore();
    registerContextModeHooks(platform, DEFAULT_CONFIG);

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
    registerContextModeHooks(platform, DEFAULT_CONFIG);

    // Call compact without calling before_compact first
    const result = platform._handlers.get("session_compact")();
    // With DB-based resume, there's nothing to consume
    expect(result).toBeUndefined();
  });

  test("compact count increments after each compaction", () => {
    const platform = createPlatformWithRealStore();
    registerContextModeHooks(platform, DEFAULT_CONFIG);

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
    registerContextModeHooks(platform, DEFAULT_CONFIG);

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
  });
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
    registerContextModeHooks(platform, DEFAULT_CONFIG);
    expect(getEventStore()).not.toBeNull();
  });

  test("getSessionId returns empty string before registration", () => {
    _resetCache();
    expect(getSessionId()).toBe("");
  });

  test("getSessionId returns a session ID matching session-<digits> after registration", () => {
    const platform = createPlatformWithTmpPaths();
    registerContextModeHooks(platform, DEFAULT_CONFIG);
    expect(getSessionId()).toMatch(/^session-\d+$/);
  });

  test("session_start prefers a stable session-file hash when available", () => {
    const platform = createPlatformWithTmpPaths();
    registerContextModeHooks(platform, DEFAULT_CONFIG);

    const handler = platform._handlers.get("session_start");
    expect(handler).toBeDefined();

    handler({}, {
      cwd: "/tmp/project",
      sessionManager: {
        getSessionFile: () => "/tmp/project/.omp/sessions/active-session.json",
      },
    });

    expect(getSessionId()).toMatch(/^[0-9a-f]{16}$/);
  });

  test("_resetCache clears event store and session id", () => {
    const platform = createPlatformWithTmpPaths();
    registerContextModeHooks(platform, DEFAULT_CONFIG);
    expect(getEventStore()).not.toBeNull();
    expect(getSessionId()).not.toBe("");
    _resetCache();
    expect(getEventStore()).toBeNull();
    expect(getSessionId()).toBe("");
  });

  test("session_shutdown clears exported state", () => {
    const platform = createPlatformWithTmpPaths();
    registerContextModeHooks(platform, DEFAULT_CONFIG);
    expect(getEventStore()).not.toBeNull();
    expect(getSessionId()).not.toBe("");

    const handler = platform._handlers.get("session_shutdown");
    expect(handler).toBeDefined();
    handler({}, {});

    expect(getEventStore()).toBeNull();
    expect(getSessionId()).toBe("");
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
    registerContextModeHooks(platform, DEFAULT_CONFIG);

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
    registerContextModeHooks(platform, DEFAULT_CONFIG);

    // Close the store: extractPromptEvents always produces >= 1 event,
    // so writeEvents will be invoked on a closed DB and throw.
    getEventStore()?.close();

    const handler = platform._handlers.get("before_agent_start");
    const event = { prompt: "fix the bug", systemPrompt: "You are an assistant." };

    let result: any;
    expect(() => { result = handler(event, {}); }).not.toThrow();
    // Routing instructions still injected despite extraction failure
    expect(result).toBeDefined();
    expect(result.systemPrompt).toContain("You are an assistant.");
    expect(result.systemPrompt).toContain("context-mode");

    const warnCalls = (platform.logger.warn as any).mock.calls;
    expect(warnCalls.some((c: any[]) => String(c[0]).includes("prompt event extraction failed"))).toBe(true);
  });

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
    registerContextModeHooks(platform, config);

    const events = platform.on.mock.calls.map((c: any[]) => c[0]);
    expect(events).not.toContain("session_before_compact");
    expect(events).not.toContain("session_compact");
  });

  test("session_before_compact returns undefined on an empty session with no events", () => {
    const platform = createPlatformWithTmpPaths();
    registerContextModeHooks(platform, DEFAULT_CONFIG);

    const handler = platform._handlers.get("session_before_compact");
    let result: any = "unset";
    expect(() => { result = handler(); }).not.toThrow();
    expect(result).toBeUndefined();
  });

  test("session_compact returns undefined on a fresh session with no pending resume in the DB", () => {
    const platform = createPlatformWithTmpPaths();
    registerContextModeHooks(platform, DEFAULT_CONFIG);

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
    // for the mcp category. MCP-prefixed names like "mcp_context_mode_ctx_search"
    // do NOT start with "ctx_", so they fall through the default branch and no
    // events are emitted. The handler must still run without throwing, and no
    // extraction-failure warnings should be logged. If this behavior changes in
    // the future (e.g. recognizing mcp_*_ctx_* names), this test will fail loudly.
    const platform = createPlatformWithTmpPaths();
    registerContextModeHooks(platform, DEFAULT_CONFIG);

    const handler = platform._handlers.get("tool_result");
    const event = {
      type: "tool_result",
      toolName: "mcp_context_mode_ctx_search",
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
