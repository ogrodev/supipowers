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

function promptText(result: any): string {
  const value = result?.systemPrompt;
  return Array.isArray(value) ? value.join("\n\n") : (value ?? "");
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

    const result = await handlers.get("before_agent_start")![0]({ systemPrompt: ["base"], sessionId: "s1" }, { cwd: process.cwd() });
    const prompt = promptText(result);

    expect(prompt).toContain("base");
    expect(prompt).toContain("# MemPalace memory");
    expect(prompt).toContain("mempalace(action=\"setup\")");
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

    const result = await handlers.get("before_agent_start")![0]({ systemPrompt: ["base"], sessionId: "s2" }, { cwd: process.cwd() });
    const prompt = promptText(result);

    expect(prompt).toContain("# MemPalace memory");
    expect(prompt).toContain("default wing:");
    expect(prompt).toContain("**MUST** call `mempalace(action=\"search\"");
    expect(prompt.length).toBeLessThan(1000);
  });

  test("caches wake-up by session, wing, and palace path", async () => {
    const { platform, handlers } = createHookPlatform();
    const execute = mock(async () => ({ ok: true, action: "wake_up", result: { text: "cached memory" }, diagnostics: {} }));
    registerMempalaceHooks(platform, config(), {
      createBridge: () => ({ execute: execute as any }),
    });
    const before = handlers.get("before_agent_start")![0];

    await before({ systemPrompt: ["base"], sessionId: "s3" }, { cwd: process.cwd() });
    await before({ systemPrompt: ["base"], sessionId: "s3" }, { cwd: process.cwd() });

    expect(execute).toHaveBeenCalledTimes(1);
  });

  test("clears wake-up cache on session_start and session_switch", async () => {
    const { platform, handlers } = createHookPlatform();
    const execute = mock(async () => ({ ok: true, action: "wake_up", result: { text: "memory" }, diagnostics: {} }));
    registerMempalaceHooks(platform, config(), {
      createBridge: () => ({ execute: execute as any }),
    });
    const before = handlers.get("before_agent_start")![0];

    await before({ systemPrompt: ["base"], sessionId: "s4" }, { cwd: process.cwd() });
    handlers.get("session_start")![0]({});
    await before({ systemPrompt: ["base"], sessionId: "s4" }, { cwd: process.cwd() });
    handlers.get("session_switch")![0]({});
    await before({ systemPrompt: ["base"], sessionId: "s4" }, { cwd: process.cwd() });

    expect(execute).toHaveBeenCalledTimes(3);
  });

  test("injects full wake-up only on turn 1 + every Nth turn; refresher otherwise", async () => {
    const { platform, handlers } = createHookPlatform();
    const execute = mock(async () => ({ ok: true, action: "wake_up", result: { text: "wake-content" }, diagnostics: {} }));
    registerMempalaceHooks(platform, config({ budgets: { ...DEFAULT_CONFIG.mempalace.budgets, wakeUpInjectionEvery: 3 } }), {
      createBridge: () => ({ execute: execute as any }),
    });
    const before = handlers.get("before_agent_start")![0];

    const turn = async () =>
      promptText(await before({ systemPrompt: ["base"], sessionId: "cadence-1" }, { cwd: process.cwd() }));

    const t1 = await turn();
    const t2 = await turn();
    const t3 = await turn();
    const t4 = await turn();
    const t6 = await (async () => { await turn(); return turn(); })(); // turn 5 then 6

    // Turn 1 (full): wake-up excerpt present.
    expect(t1).toContain("## Wake-up excerpt");
    expect(t1).toContain("wake-content");
    // Turns 2 and 4 (refresher): compact one-line header, no excerpt.
    expect(t2).toContain("# MemPalace memory: wing=");
    expect(t2).not.toContain("## Wake-up excerpt");
    expect(t4).toContain("# MemPalace memory: wing=");
    expect(t4).not.toContain("## Wake-up excerpt");
    // Turn 3 and 6 (cadence hit): full block again.
    expect(t3).toContain("## Wake-up excerpt");
    expect(t6).toContain("## Wake-up excerpt");
    // Bridge wake_up only fires on turn 1 (cached after); turns 3/6 reuse cache.
    const wakeCalls = execute.mock.calls.filter((c: any[]) => c[0].action === "wake_up").length;
    expect(wakeCalls).toBe(1);
  });

  test("session_start and session_switch reset the cadence counter", async () => {
    const { platform, handlers } = createHookPlatform();
    const execute = mock(async () => ({ ok: true, action: "wake_up", result: { text: "wake-content" }, diagnostics: {} }));
    registerMempalaceHooks(platform, config({ budgets: { ...DEFAULT_CONFIG.mempalace.budgets, wakeUpInjectionEvery: 10 } }), {
      createBridge: () => ({ execute: execute as any }),
    });
    const before = handlers.get("before_agent_start")![0];

    const turn = async () =>
      promptText(await before({ systemPrompt: ["base"], sessionId: "cadence-2" }, { cwd: process.cwd() }));

    expect(await turn()).toContain("## Wake-up excerpt"); // turn 1: full
    expect(await turn()).not.toContain("## Wake-up excerpt"); // turn 2: refresher
    handlers.get("session_start")![0]({});
    // After clear, next turn becomes turn 1 again → full injection.
    expect(await turn()).toContain("## Wake-up excerpt");
    expect(await turn()).not.toContain("## Wake-up excerpt");
    handlers.get("session_switch")![0]({});
    expect(await turn()).toContain("## Wake-up excerpt");
  });

  test("auto-searches the prompt and injects relevant memories", async () => {
    const { platform, handlers } = createHookPlatform();
    const execute = mock(async (req: any) => {
      if (req.action === "wake_up") {
        return { ok: true, action: "wake_up", result: { text: "wake" }, diagnostics: {} };
      }
      if (req.action === "search") {
        return {
          ok: true,
          action: "search",
          result: {
            query: req.query,
            results: [
              { text: "auth uses JWT bearer tokens with 30 min expiry.", source_file: "auth.md", room: "src", similarity: 0.92, bm25_score: 0.6 },
              { text: "rate limiter middleware lives in src/middleware/limit.ts", source_file: "middleware.md", room: "src", similarity: 0.88, bm25_score: 0.5 },
            ],
          },
          diagnostics: {},
        };
      }
      return { ok: false, action: req.action, error: { code: "unknown" }, diagnostics: {} };
    });
    registerMempalaceHooks(platform, config(), {
      createBridge: () => ({ execute: execute as any }),
    });

    const before = handlers.get("before_agent_start")![0];
    const result = await before(
      { systemPrompt: ["base"], sessionId: "auto1", prompt: "How does our auth and rate limiting work?" },
      { cwd: process.cwd() },
    );
    const prompt = promptText(result);

    expect(prompt).toContain("# MemPalace memory");
    expect(prompt).toContain("## Relevant memories");
    expect(prompt).toContain("auth.md");
    expect(prompt).toContain("middleware.md");
    // Hits use the compact `[room/source] ...` format with a 120-char snippet cap.
    expect(prompt).toMatch(/\[src\/auth\.md\]/);
    // Both wake_up and search should fire on first turn.
    const actions = execute.mock.calls.map((call: any[]) => call[0].action).sort();
    expect(actions).toEqual(["search", "wake_up"]);
  });

  test("filters out low-relevance hits from the auto-search injection", async () => {
    const { platform, handlers } = createHookPlatform();
    const execute = mock(async (req: any) => {
      if (req.action === "wake_up") return { ok: true, action: "wake_up", result: { text: "wake" }, diagnostics: {} };
      if (req.action === "search") {
        return {
          ok: true,
          action: "search",
          result: {
            results: [
              { text: "tangentially related noise", source_file: "x.md", room: "src", similarity: 0.2, bm25_score: 0.05 },
            ],
          },
          diagnostics: {},
        };
      }
      return { ok: false, action: req.action, error: { code: "x" }, diagnostics: {} };
    });
    registerMempalaceHooks(platform, config(), {
      createBridge: () => ({ execute: execute as any }),
    });

    const before = handlers.get("before_agent_start")![0];
    const result = await before(
      { systemPrompt: ["base"], sessionId: "auto2", prompt: "Some long-enough query about anything important." },
      { cwd: process.cwd() },
    );
    expect(promptText(result)).not.toContain("## Relevant memories");
  });

  test("skips auto-search for trivial prompts (yes, ok, thanks)", async () => {
    const { platform, handlers } = createHookPlatform();
    const execute = mock(async () => ({ ok: true, action: "wake_up", result: { text: "wake" }, diagnostics: {} }));
    registerMempalaceHooks(platform, config(), {
      createBridge: () => ({ execute: execute as any }),
    });

    const before = handlers.get("before_agent_start")![0];
    for (const trivial of ["", "yes", "ok", "thanks", "go"]) {
      execute.mockClear();
      await before(
        { systemPrompt: ["base"], sessionId: `trivial-${trivial}`, prompt: trivial },
        { cwd: process.cwd() },
      );
      const actions = execute.mock.calls.map((c: any[]) => c[0].action);
      expect(actions).not.toContain("search");
    }
  });

  test("auto-search disabled via config does not call search", async () => {
    const { platform, handlers } = createHookPlatform();
    const execute = mock(async () => ({ ok: true, action: "wake_up", result: { text: "wake" }, diagnostics: {} }));
    registerMempalaceHooks(platform, config({ hooks: { ...DEFAULT_CONFIG.mempalace.hooks, autoSearchOnPrompt: false } }), {
      createBridge: () => ({ execute: execute as any }),
    });

    const before = handlers.get("before_agent_start")![0];
    await before(
      { systemPrompt: ["base"], sessionId: "off1", prompt: "tell me about prior auth decisions" },
      { cwd: process.cwd() },
    );
    const actions = execute.mock.calls.map((c: any[]) => c[0].action);
    expect(actions).not.toContain("search");
  });

  test("auto-search failures never block the turn", async () => {
    const { platform, handlers } = createHookPlatform();
    const execute = mock(async (req: any) => {
      if (req.action === "wake_up") return { ok: true, action: "wake_up", result: { text: "wake" }, diagnostics: {} };
      if (req.action === "search") throw new Error("synthetic search crash");
      return { ok: false, action: req.action, error: { code: "x" }, diagnostics: {} };
    });
    registerMempalaceHooks(platform, config(), {
      createBridge: () => ({ execute: execute as any }),
    });

    const before = handlers.get("before_agent_start")![0];
    const result = await before(
      { systemPrompt: ["base"], sessionId: "crash1", prompt: "What did we decide about caching last sprint?" },
      { cwd: process.cwd() },
    );
    const prompt = promptText(result);
    expect(prompt).toContain("# MemPalace memory");
    expect(prompt).not.toContain("## Relevant memories");
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
