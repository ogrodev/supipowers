import { describe, expect, mock, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { registerMempalaceHooks } from "../../src/mempalace/hooks.js";
import { createMockPlatform } from "../../src/platform/test-utils.js";

function createHookPlatform() {
  const handlers = new Map<string, Function[]>();
  const platform = createMockPlatform({
    on: mock((event: string, handler: Function) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }) as any,
  });
  return { platform, handlers };
}

function config(overrides: Partial<typeof DEFAULT_CONFIG.mempalace> = {}) {
  return {
    ...DEFAULT_CONFIG,
    mempalace: {
      ...DEFAULT_CONFIG.mempalace,
      ...overrides,
      hooks: { ...DEFAULT_CONFIG.mempalace.hooks, ...(overrides.hooks ?? {}) },
      budgets: { ...DEFAULT_CONFIG.mempalace.budgets, ...(overrides.budgets ?? {}) },
    },
  };
}

describe("registerMempalaceHooks wake-up", () => {
  test("does not register hooks when MemPalace is disabled", () => {
    const { platform } = createHookPlatform();

    registerMempalaceHooks(platform, config({ enabled: false }));

    expect(platform.on).not.toHaveBeenCalled();
  });

  test("injects setup guidance when runtime is missing", async () => {
    const { platform, handlers } = createHookPlatform();
    registerMempalaceHooks(platform, config(), {
      createBridge: () => ({
        execute: async () => ({
          ok: false,
          action: "wake_up",
          error: { code: "mempalace_missing", message: "missing" },
          diagnostics: {},
        }),
      }),
    });

    const result = await handlers.get("before_agent_start")![0]({ systemPrompt: "base", sessionId: "s1" }, { cwd: process.cwd() });

    expect(result.systemPrompt).toContain("base");
    expect(result.systemPrompt).toContain("# MemPalace memory");
    expect(result.systemPrompt).toContain("mempalace(action=\"setup\")");
  });

  test("injects bounded wake-up block and protocol guidance", async () => {
    const { platform, handlers } = createHookPlatform();
    registerMempalaceHooks(platform, config({ budgets: { ...DEFAULT_CONFIG.mempalace.budgets, wakeUpTokens: 30 } }), {
      createBridge: () => ({
        execute: async () => ({
          ok: true,
          action: "wake_up",
          result: { text: `important ${"memory ".repeat(100)}` },
          diagnostics: {},
        }),
      }),
    });

    const result = await handlers.get("before_agent_start")![0]({ systemPrompt: "base", sessionId: "s2" }, { cwd: process.cwd() });

    expect(result.systemPrompt).toContain("# MemPalace memory");
    expect(result.systemPrompt).toContain("default wing:");
    expect(result.systemPrompt).toContain("Search MemPalace before answering past-fact questions");
    expect(result.systemPrompt.length).toBeLessThan(1000);
  });

  test("caches wake-up by session, wing, and palace path", async () => {
    const { platform, handlers } = createHookPlatform();
    const execute = mock(async () => ({ ok: true, action: "wake_up", result: { text: "cached memory" }, diagnostics: {} }));
    registerMempalaceHooks(platform, config(), {
      createBridge: () => ({ execute: execute as any }),
    });
    const before = handlers.get("before_agent_start")![0];

    await before({ systemPrompt: "base", sessionId: "s3" }, { cwd: process.cwd() });
    await before({ systemPrompt: "base", sessionId: "s3" }, { cwd: process.cwd() });

    expect(execute).toHaveBeenCalledTimes(1);
  });

  test("clears wake-up cache on session_start and session_switch", async () => {
    const { platform, handlers } = createHookPlatform();
    const execute = mock(async () => ({ ok: true, action: "wake_up", result: { text: "memory" }, diagnostics: {} }));
    registerMempalaceHooks(platform, config(), {
      createBridge: () => ({ execute: execute as any }),
    });
    const before = handlers.get("before_agent_start")![0];

    await before({ systemPrompt: "base", sessionId: "s4" }, { cwd: process.cwd() });
    handlers.get("session_start")![0]({});
    await before({ systemPrompt: "base", sessionId: "s4" }, { cwd: process.cwd() });
    handlers.get("session_switch")![0]({});
    await before({ systemPrompt: "base", sessionId: "s4" }, { cwd: process.cwd() });

    expect(execute).toHaveBeenCalledTimes(3);
  });
});

describe("registerMempalaceHooks compaction checkpoint", () => {
  test("writes add_drawer checkpoint and never cancels compaction", async () => {
    const { platform, handlers } = createHookPlatform();
    const execute = mock(async () => ({ ok: true, action: "add_drawer", result: { id: "d1" }, diagnostics: {} }));
    registerMempalaceHooks(platform, config(), {
      createBridge: () => ({ execute: execute as any }),
      getEventStore: () => null,
      getSessionId: () => "compact-session",
      now: () => "2026-05-04T12:00:00.000Z",
    });

    const compact = handlers.get("session_before_compact")?.[0];
    expect(compact).toBeDefined();
    if (!compact) throw new Error("missing session_before_compact handler");
    const result = await compact({}, { cwd: process.cwd() });

    expect(result).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
    const compactCall = execute.mock.calls[0] as any[] | undefined;
    expect(compactCall).toBeDefined();
    if (!compactCall) throw new Error("missing add_drawer call");
    expect(compactCall[0]).toMatchObject({
      action: "add_drawer",
      room: "compaction-checkpoints",
      added_by: "omp",
      source_file: "omp-session:compact-session:compaction:2026-05-04T12:00:00.000Z",
    });
    expect((compactCall[0] as any).content).toContain("MemPalace compaction checkpoint");
  });

  test("swallows duplicate, bridge failure, and timeout errors", async () => {
    const responses = [
      { ok: false, action: "add_drawer", error: { code: "duplicate", message: "already exists" }, diagnostics: {} },
      { ok: false, action: "add_drawer", error: { code: "bridge_process_failed", message: "failed" }, diagnostics: {} },
      { ok: false, action: "add_drawer", error: { code: "bridge_timeout", message: "timeout" }, diagnostics: {} },
    ];
    for (const response of responses) {
      const { platform, handlers } = createHookPlatform();
      registerMempalaceHooks(platform, config(), {
        createBridge: () => ({ execute: async () => response as any }),
        getSessionId: () => "compact-session",
        now: () => "2026-05-04T12:00:00.000Z",
      });
      const compact = handlers.get("session_before_compact")?.[0];
      expect(compact).toBeDefined();
      if (!compact) throw new Error("missing session_before_compact handler");
      await expect(compact({}, { cwd: process.cwd() })).resolves.toBeUndefined();
    }
  });

  test("does not auto-install during compaction", async () => {
    const { platform, handlers } = createHookPlatform();
    const execute = mock(async () => ({ ok: false, action: "add_drawer", error: { code: "mempalace_missing", message: "missing" }, diagnostics: {} }));
    registerMempalaceHooks(platform, config(), {
      createBridge: () => ({ execute: execute as any }),
      getSessionId: () => "compact-session",
    });

    const compact = handlers.get("session_before_compact")?.[0];
    expect(compact).toBeDefined();
    if (!compact) throw new Error("missing session_before_compact handler");
    await compact({}, { cwd: process.cwd() });

    expect(execute).toHaveBeenCalledTimes(1);
    const compactCall = execute.mock.calls[0] as any[] | undefined;
    expect(compactCall).toBeDefined();
    if (!compactCall) throw new Error("missing add_drawer call");
    expect(compactCall[0].action).toBe("add_drawer");
  });
});

describe("registerMempalaceHooks shutdown diary", () => {
  test("writes diary entry with default agent, project wing, and metadata", async () => {
    const { platform, handlers } = createHookPlatform();
    const execute = mock(async () => ({ ok: true, action: "diary_write", result: { id: "entry" }, diagnostics: {} }));
    registerMempalaceHooks(platform, config(), {
      createBridge: () => ({ execute: execute as any }),
      getSessionId: () => "shutdown-session",
      now: () => "2026-05-04T13:00:00.000Z",
    });

    const shutdown = handlers.get("session_shutdown")?.[0];
    expect(shutdown).toBeDefined();
    if (!shutdown) throw new Error("missing session_shutdown handler");
    const result = await shutdown({}, { cwd: process.cwd() });

    expect(result).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
    const shutdownCall = execute.mock.calls[0] as any[] | undefined;
    expect(shutdownCall).toBeDefined();
    if (!shutdownCall) throw new Error("missing diary_write call");
    expect(shutdownCall[0]).toMatchObject({
      action: "diary_write",
      agent_name: "omp",
      topic: "shutdown",
      source_file: "omp-session:shutdown-session:shutdown:2026-05-04T13:00:00.000Z",
      timeout: DEFAULT_CONFIG.mempalace.timeouts.hookMs,
    });
    expect((shutdownCall[0] as any).wing).toBeTruthy();
    expect((shutdownCall[0] as any).entry).toContain("MemPalace shutdown diary");
  });

  test("swallows shutdown write failures", async () => {
    const { platform, handlers } = createHookPlatform();
    registerMempalaceHooks(platform, config(), {
      createBridge: () => ({
        execute: async () => ({ ok: false, action: "diary_write", error: { code: "bridge_timeout", message: "timeout" }, diagnostics: {} }),
      }),
      getSessionId: () => "shutdown-session",
    });

    const shutdown = handlers.get("session_shutdown")?.[0];
    expect(shutdown).toBeDefined();
    if (!shutdown) throw new Error("missing session_shutdown handler");
    await expect(shutdown({}, { cwd: process.cwd() })).resolves.toBeUndefined();
  });
});
