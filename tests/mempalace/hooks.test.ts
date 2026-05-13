import { describe, expect, mock, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { _resetMempalaceHookState, registerMempalaceHooks } from "../../src/mempalace/hooks.js";
import { MEMPALACE_MAX_QUERY_LENGTH } from "../../src/mempalace/upstream-limits.js";
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
      timeouts: { ...DEFAULT_CONFIG.mempalace.timeouts, ...(overrides.timeouts ?? {}) },
    },
  };
}

const EXPECTED_HOOK_TIMEOUT_SECONDS = Math.max(1, Math.floor(DEFAULT_CONFIG.mempalace.timeouts.hookMs / 1000));

function promptText(result: any): string {
  const value = result?.systemPrompt;
  return Array.isArray(value) ? value.join("\n\n") : (value ?? "");
}

/** Wraps deps with a ready-state install snapshot so tests skip real FS checks. */
function readyDeps(extra: Parameters<typeof registerMempalaceHooks>[2] = {}): Parameters<typeof registerMempalaceHooks>[2] {
  return { snapshotInstall: () => ({ ready: true }), ...extra };
}

describe("registerMempalaceHooks wake-up", () => {
  test("does not register hooks when MemPalace is disabled", () => {
    const { platform } = createHookPlatform();

    registerMempalaceHooks(platform, config({ enabled: false }));

    expect(platform.on).not.toHaveBeenCalled();
  });

  test("injects setup guidance when runtime is missing", async () => {
    const { platform, handlers } = createHookPlatform();
    registerMempalaceHooks(platform, config(), readyDeps({
      createBridge: () => ({
        execute: async () => ({
          ok: false,
          action: "wake_up",
          error: { code: "mempalace_missing", message: "missing" },
          diagnostics: {},
        }),
      }),
    }));

    const result = await handlers.get("before_agent_start")![0]({ systemPrompt: ["base"], sessionId: "s1" }, { cwd: process.cwd() });
    const prompt = promptText(result);

    expect(prompt).toContain("base");
    expect(prompt).toContain("# MemPalace memory");
    expect(prompt).toContain("mempalace(action=\"setup\")");
  });

  test("passes hook timeouts to the bridge without exceeding the millisecond budget", async () => {
    const { platform, handlers } = createHookPlatform();
    const execute = mock(async (req: any) => {
      if (req.action === "wake_up_and_search") return { ok: true, action: "wake_up_and_search", result: { wake: { text: "wake" }, search: { results: [] } }, diagnostics: {} };
      if (req.action === "add_drawer") return { ok: true, action: "add_drawer", result: { id: "d1" }, diagnostics: {} };
      if (req.action === "diary_write") return { ok: true, action: "diary_write", result: { id: "e1" }, diagnostics: {} };
      return { ok: true, action: req.action, result: {}, diagnostics: {} };
    });
    const hookMs = 6500;
    const expectedTimeoutSeconds = 6;

    registerMempalaceHooks(platform, config({ timeouts: { ...DEFAULT_CONFIG.mempalace.timeouts, hookMs } }), readyDeps({
      createBridge: () => ({ execute: execute as any }),
      getEventStore: () => null,
      getSessionId: () => "timeout-session",
      now: () => "2026-05-04T12:00:00.000Z",
    }));

    await handlers.get("before_agent_start")![0](
      { systemPrompt: ["base"], sessionId: "timeout-before", prompt: "What did we decide about auth?" },
      { cwd: process.cwd() },
    );
    await handlers.get("session_before_compact")![0]({}, { cwd: process.cwd() });
    await handlers.get("session_shutdown")![0]({}, { cwd: process.cwd() });

    for (const action of ["wake_up_and_search", "add_drawer", "diary_write"]) {
      const call = execute.mock.calls.find((candidate: any[]) => candidate[0].action === action) as any[] | undefined;
      expect(call?.[0].timeout).toBe(expectedTimeoutSeconds);
      expect(call?.[0].timeout * 1000).toBeLessThanOrEqual(hookMs);
    }
  });

  test("injects bounded wake-up block and protocol guidance", async () => {
    const { platform, handlers } = createHookPlatform();
    registerMempalaceHooks(platform, config({ budgets: { ...DEFAULT_CONFIG.mempalace.budgets, wakeUpTokens: 30 } }), readyDeps({
      createBridge: () => ({
        execute: async () => ({
          ok: true,
          action: "wake_up_and_search",
          result: { wake: { text: `important ${"memory ".repeat(100)}` }, search: null },
          diagnostics: {},
        }),
      }),
    }));

    const result = await handlers.get("before_agent_start")![0]({ systemPrompt: ["base"], sessionId: "s2" }, { cwd: process.cwd() });
    const prompt = promptText(result);

    expect(prompt).toContain("# MemPalace memory");
    expect(prompt).toContain("default wing:");
    expect(prompt).toContain("**MUST** call `mempalace(action=\"search\"");
    expect(prompt.length).toBeLessThan(1000);
  });

  test("caches wake-up by session, wing, and palace path", async () => {
    const { platform, handlers } = createHookPlatform();
    const execute = mock(async () => ({ ok: true, action: "wake_up_and_search", result: { wake: { text: "cached memory" }, search: null }, diagnostics: {} }));
    registerMempalaceHooks(platform, config(), readyDeps({
      createBridge: () => ({ execute: execute as any }),
    }));
    const before = handlers.get("before_agent_start")![0];

    await before({ systemPrompt: ["base"], sessionId: "s3" }, { cwd: process.cwd() });
    await before({ systemPrompt: ["base"], sessionId: "s3" }, { cwd: process.cwd() });

    expect(execute).toHaveBeenCalledTimes(1);
  });

  test("clears wake-up cache on session_start and session_switch", async () => {
    const { platform, handlers } = createHookPlatform();
    const execute = mock(async () => ({ ok: true, action: "wake_up_and_search", result: { wake: { text: "memory" }, search: null }, diagnostics: {} }));
    registerMempalaceHooks(platform, config(), readyDeps({
      createBridge: () => ({ execute: execute as any }),
    }));
    const before = handlers.get("before_agent_start")![0];

    await before({ systemPrompt: ["base"], sessionId: "s4" }, { cwd: process.cwd() });
    handlers.get("session_start")![0]({ sessionId: "s4" });
    await before({ systemPrompt: ["base"], sessionId: "s4" }, { cwd: process.cwd() });
    handlers.get("session_switch")![0]({ sessionId: "s4" });
    await before({ systemPrompt: ["base"], sessionId: "s4" }, { cwd: process.cwd() });

    expect(execute).toHaveBeenCalledTimes(3);
  });

  test("injects full wake-up only on turn 1 + every Nth turn; refresher otherwise", async () => {
    const { platform, handlers } = createHookPlatform();
    const execute = mock(async () => ({ ok: true, action: "wake_up_and_search", result: { wake: { text: "wake-content" }, search: null }, diagnostics: {} }));
    registerMempalaceHooks(platform, config({ budgets: { ...DEFAULT_CONFIG.mempalace.budgets, wakeUpInjectionEvery: 3 } }), readyDeps({
      createBridge: () => ({ execute: execute as any }),
    }));
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
    // wake_up_and_search fires only on turn 1 (cached after); turns 3/6 reuse cache.
    const wakeCalls = execute.mock.calls.filter((c: any[]) => c[0].action === "wake_up_and_search").length;
    expect(wakeCalls).toBe(1);
  });

  test("session_start and session_switch reset the cadence counter", async () => {
    const { platform, handlers } = createHookPlatform();
    const execute = mock(async () => ({ ok: true, action: "wake_up_and_search", result: { wake: { text: "wake-content" }, search: null }, diagnostics: {} }));
    registerMempalaceHooks(platform, config({ budgets: { ...DEFAULT_CONFIG.mempalace.budgets, wakeUpInjectionEvery: 10 } }), readyDeps({
      createBridge: () => ({ execute: execute as any }),
    }));
    const before = handlers.get("before_agent_start")![0];

    const turn = async () =>
      promptText(await before({ systemPrompt: ["base"], sessionId: "cadence-2" }, { cwd: process.cwd() }));

    expect(await turn()).toContain("## Wake-up excerpt"); // turn 1: full
    expect(await turn()).not.toContain("## Wake-up excerpt"); // turn 2: refresher
    handlers.get("session_start")![0]({ sessionId: "cadence-2" });
    // After clear, next turn becomes turn 1 again → full injection.
    expect(await turn()).toContain("## Wake-up excerpt");
    expect(await turn()).not.toContain("## Wake-up excerpt");
    handlers.get("session_switch")![0]({ sessionId: "cadence-2" });
    expect(await turn()).toContain("## Wake-up excerpt");
  });

  test("auto-searches the prompt and injects relevant memories", async () => {
    const { platform, handlers } = createHookPlatform();
    const execute = mock(async (req: any) => {
      if (req.action === "wake_up_and_search") {
        return {
          ok: true,
          action: "wake_up_and_search",
          result: {
            wake: { text: "wake" },
            search: {
              query: req.query,
              results: [
                { text: "auth uses JWT bearer tokens with 30 min expiry.", source_file: "auth.md", room: "src", similarity: 0.92, bm25_score: 0.6 },
                { text: "rate limiter middleware lives in src/middleware/limit.ts", source_file: "middleware.md", room: "src", similarity: 0.88, bm25_score: 0.5 },
              ],
            },
          },
          diagnostics: {},
        };
      }
      return { ok: false, action: req.action, error: { code: "unknown" }, diagnostics: {} };
    });
    registerMempalaceHooks(platform, config(), readyDeps({
      createBridge: () => ({ execute: execute as any }),
    }));

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
    // One batched call on the first (cadence-gated) turn, not two.
    const actions = execute.mock.calls.map((call: any[]) => call[0].action).sort();
    expect(actions).toEqual(["wake_up_and_search"]);
  });

  test("passes full long prompts to upstream MemPalace sanitization", async () => {
    const { platform, handlers } = createHookPlatform();
    const execute = mock(async (req: any) => {
      if (req.action === "wake_up_and_search") {
        return { ok: true, action: "wake_up_and_search", result: { wake: { text: "wake" }, search: { results: [] } }, diagnostics: {} };
      }
      return { ok: false, action: req.action, error: { code: "x" }, diagnostics: {} };
    });
    registerMempalaceHooks(platform, config(), readyDeps({
      createBridge: () => ({ execute: execute as any }),
    }));

    const question = "What did we decide about vector index repair?";
    const longPrompt = `${"context ".repeat(40)}${question}`;
    expect(longPrompt.length).toBeGreaterThan(MEMPALACE_MAX_QUERY_LENGTH);

    const before = handlers.get("before_agent_start")![0];
    await before(
      { systemPrompt: ["base"], sessionId: "auto-long-prompt", prompt: longPrompt },
      { cwd: process.cwd() },
    );

    // On first (cadence-gated) turn with a search-worthy prompt, the query is
    // embedded in the batched wake_up_and_search call — not a separate search.
    const batchCall = execute.mock.calls.find((call: any[]) => call[0].action === "wake_up_and_search") as any[] | undefined;
    expect(batchCall).toBeDefined();
    expect(batchCall?.[0].query).toBe(longPrompt);
    expect(batchCall?.[0].query).toContain(question);
  });

  test("filters out low-relevance hits from the auto-search injection", async () => {
    const { platform, handlers } = createHookPlatform();
    const execute = mock(async (req: any) => {
      if (req.action === "wake_up_and_search") {
        return {
          ok: true,
          action: "wake_up_and_search",
          result: {
            wake: { text: "wake" },
            search: {
              results: [
                { text: "tangentially related noise", source_file: "x.md", room: "src", similarity: 0.2, bm25_score: 0.05 },
              ],
            },
          },
          diagnostics: {},
        };
      }
      return { ok: false, action: req.action, error: { code: "x" }, diagnostics: {} };
    });
    registerMempalaceHooks(platform, config(), readyDeps({
      createBridge: () => ({ execute: execute as any }),
    }));

    const before = handlers.get("before_agent_start")![0];
    const result = await before(
      { systemPrompt: ["base"], sessionId: "auto2", prompt: "Some long-enough query about anything important." },
      { cwd: process.cwd() },
    );
    expect(promptText(result)).not.toContain("## Relevant memories");
  });

  test("skips auto-search for trivial prompts (yes, ok, thanks)", async () => {
    const { platform, handlers } = createHookPlatform();
    const execute = mock(async () => ({ ok: true, action: "wake_up_and_search", result: { wake: { text: "wake" }, search: null }, diagnostics: {} }));
    registerMempalaceHooks(platform, config(), readyDeps({
      createBridge: () => ({ execute: execute as any }),
    }));

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
    const execute = mock(async () => ({ ok: true, action: "wake_up_and_search", result: { wake: { text: "wake" }, search: null }, diagnostics: {} }));
    registerMempalaceHooks(platform, config({ hooks: { ...DEFAULT_CONFIG.mempalace.hooks, autoSearchOnPrompt: false } }), readyDeps({
      createBridge: () => ({ execute: execute as any }),
    }));

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
      if (req.action === "wake_up_and_search") {
        // Python catches search failures internally and returns search: null.
        return { ok: true, action: "wake_up_and_search", result: { wake: { text: "wake" }, search: null }, diagnostics: {} };
      }
      return { ok: false, action: req.action, error: { code: "x" }, diagnostics: {} };
    });
    registerMempalaceHooks(platform, config(), readyDeps({
      createBridge: () => ({ execute: execute as any }),
    }));

    const before = handlers.get("before_agent_start")![0];
    const result = await before(
      { systemPrompt: ["base"], sessionId: "crash1", prompt: "What did we decide about caching last sprint?" },
      { cwd: process.cwd() },
    );
    const prompt = promptText(result);
    expect(prompt).toContain("# MemPalace memory");
    expect(prompt).not.toContain("## Relevant memories");
  });

  test("wake failure in batched call still shows search hits with a wake notice", async () => {
    const { platform, handlers } = createHookPlatform();
    const execute = mock(async (req: any) => {
      if (req.action === "wake_up_and_search") {
        return {
          ok: true,
          action: "wake_up_and_search",
          result: {
            wake: null,
            wake_error: "mempalace_runtime_error: wake exploded",
            search: {
              results: [
                { text: "search survived", source_file: "survived.md", room: "src", similarity: 0.95, bm25_score: 0.8 },
              ],
            },
          },
          diagnostics: {},
        };
      }
      return { ok: true, action: req.action, result: {}, diagnostics: {} };
    });
    registerMempalaceHooks(platform, config(), readyDeps({
      createBridge: () => ({ execute: execute as any }),
    }));

    const before = handlers.get("before_agent_start")![0];
    const result = await before(
      { systemPrompt: ["base"], sessionId: "wake-failure-search-survives", prompt: "What did we decide about auth?" },
      { cwd: process.cwd() },
    );
    const prompt = promptText(result);

    expect(prompt).toContain("Wake-up failed: mempalace_runtime_error: wake exploded");
    expect(prompt).toContain("## Relevant memories");
    expect(prompt).toContain("survived.md");
  });

  test("batches wake and search into exactly one bridge call on cadence-gated turns (not two)", async () => {
    const { platform, handlers } = createHookPlatform();
    let callCount = 0;
    const execute = mock(async (req: any) => {
      callCount++;
      if (req.action === "wake_up_and_search") {
        return {
          ok: true,
          action: "wake_up_and_search",
          result: {
            wake: { text: "batched-wake" },
            search: {
              query: req.query,
              results: [
                { text: "auth uses JWT", source_file: "auth.md", room: "src", similarity: 0.91, bm25_score: 0.6 },
              ],
            },
          },
          diagnostics: {},
        };
      }
      return { ok: true, action: req.action, result: {}, diagnostics: {} };
    });
    registerMempalaceHooks(platform, config(), readyDeps({
      createBridge: () => ({ execute: execute as any }),
    }));

    const before = handlers.get("before_agent_start")![0];
    // Turn 1 is always cadence-gated; provide a search-worthy prompt so the
    // old code would have issued two calls (wake_up + search).
    callCount = 0;
    await before(
      { systemPrompt: ["base"], sessionId: "batch-test-1", prompt: "What did we decide about auth?" },
      { cwd: process.cwd() },
    );
    expect(callCount).toBe(1);
    expect(execute.mock.calls[0][0].action).toBe("wake_up_and_search");
    expect(execute.mock.calls[0][0].query).toBe("What did we decide about auth?");
  });

  test("golden-string: output identical to two-call path when both halves succeed", async () => {
    // Verifies the combined block matches what wake_up + separate search produced,
    // so the user-visible text is regression-proof against the batching refactor.
    const { platform, handlers } = createHookPlatform();
    const execute = mock(async (req: any) => {
      if (req.action === "wake_up_and_search") {
        return {
          ok: true,
          action: "wake_up_and_search",
          result: {
            wake: { text: "golden wake content" },
            search: {
              results: [
                { text: "golden hit", source_file: "golden.md", room: "src", similarity: 0.95, bm25_score: 0.8 },
              ],
            },
          },
          diagnostics: {},
        };
      }
      return { ok: true, action: req.action, result: {}, diagnostics: {} };
    });
    registerMempalaceHooks(platform, config(), readyDeps({
      createBridge: () => ({ execute: execute as any }),
    }));

    const before = handlers.get("before_agent_start")![0];
    const result = await before(
      { systemPrompt: ["base"], sessionId: "golden-1", prompt: "How does auth work?" },
      { cwd: process.cwd() },
    );
    const prompt = promptText(result);
    expect(prompt).toContain("# MemPalace memory");
    expect(prompt).toContain("## Wake-up excerpt");
    expect(prompt).toContain("golden wake content");
    expect(prompt).toContain("## Relevant memories");
    expect(prompt).toContain("golden.md");
  });
});

describe("registerMempalaceHooks compaction checkpoint", () => {
  test("writes add_drawer checkpoint and never cancels compaction", async () => {
    const { platform, handlers } = createHookPlatform();
    const execute = mock(async () => ({ ok: true, action: "add_drawer", result: { id: "d1" }, diagnostics: {} }));
    registerMempalaceHooks(platform, config(), readyDeps({
      createBridge: () => ({ execute: execute as any }),
      getEventStore: () => null,
      getSessionId: () => "compact-session",
      now: () => "2026-05-04T12:00:00.000Z",
    }));

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
      registerMempalaceHooks(platform, config(), readyDeps({
        createBridge: () => ({ execute: async () => response as any }),
        getSessionId: () => "compact-session",
        now: () => "2026-05-04T12:00:00.000Z",
      }));
      const compact = handlers.get("session_before_compact")?.[0];
      expect(compact).toBeDefined();
      if (!compact) throw new Error("missing session_before_compact handler");
      await expect(compact({}, { cwd: process.cwd() })).resolves.toBeUndefined();
    }
  });

  test("does not auto-install during compaction", async () => {
    const { platform, handlers } = createHookPlatform();
    const execute = mock(async () => ({ ok: false, action: "add_drawer", error: { code: "mempalace_missing", message: "missing" }, diagnostics: {} }));
    registerMempalaceHooks(platform, config(), readyDeps({
      createBridge: () => ({ execute: execute as any }),
      getSessionId: () => "compact-session",
    }));

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
    registerMempalaceHooks(platform, config(), readyDeps({
      createBridge: () => ({ execute: execute as any }),
      getSessionId: () => "shutdown-session",
      now: () => "2026-05-04T13:00:00.000Z",
    }));

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
      timeout: EXPECTED_HOOK_TIMEOUT_SECONDS,
    });
    expect((shutdownCall[0] as any).wing).toBeTruthy();
    expect((shutdownCall[0] as any).entry).toContain("MemPalace shutdown diary");
  });

  test("swallows shutdown write failures", async () => {
    const { platform, handlers } = createHookPlatform();
    registerMempalaceHooks(platform, config(), readyDeps({
      createBridge: () => ({
        execute: async () => ({ ok: false, action: "diary_write", error: { code: "bridge_timeout", message: "timeout" }, diagnostics: {} }),
      }),
      getSessionId: () => "shutdown-session",
    }));

    const shutdown = handlers.get("session_shutdown")?.[0];
    expect(shutdown).toBeDefined();
    if (!shutdown) throw new Error("missing session_shutdown handler");
    await expect(shutdown({}, { cwd: process.cwd() })).resolves.toBeUndefined();
  });
});

describe("registerMempalaceHooks install gating and cache hygiene", () => {
  test("returns static guidance block without calling bridge when not installed", async () => {
    const { platform, handlers } = createHookPlatform();
    const execute = mock(async () => ({ ok: true, action: "wake_up", result: { text: "wake" }, diagnostics: {} }));
    registerMempalaceHooks(platform, config(), {
      createBridge: () => ({ execute: execute as any }),
      snapshotInstall: () => ({ ready: false }),
    });

    const before = handlers.get("before_agent_start")?.[0];
    expect(before).toBeDefined();
    if (!before) throw new Error("missing before_agent_start handler");
    const result = await before({ systemPrompt: ["base"], sessionId: "not-ready" }, { cwd: process.cwd() });
    const prompt = promptText(result);

    expect(prompt).toContain("base");
    expect(prompt).toContain("# MemPalace memory");
    expect(prompt).toContain("mempalace(action=\"setup\")");
    const compact = handlers.get("session_before_compact")?.[0];
    expect(compact).toBeDefined();
    if (!compact) throw new Error("missing session_before_compact handler");
    await compact({}, { cwd: process.cwd() });

    const shutdownHandlers = handlers.get("session_shutdown") ?? [];
    expect(shutdownHandlers.length).toBeGreaterThan(0);
    for (const handler of shutdownHandlers) {
      await handler({ sessionId: "not-ready" }, { cwd: process.cwd() });
    }

    expect(execute).not.toHaveBeenCalled();
  });

  test("checks install readiness against each hook cwd", async () => {
    const { platform, handlers } = createHookPlatform();
    const workspaceCwd = `${process.cwd()}-ready-workspace`;
    const snapshotCwds: string[] = [];
    let bridgeCwd = "";
    const execute = mock(async () => ({
      ok: true,
      action: "wake_up_and_search",
      result: { wake: { text: "workspace wake" }, search: null },
      diagnostics: {},
    }));

    registerMempalaceHooks(platform, config(), {
      snapshotInstall: (_paths, cwd) => {
        snapshotCwds.push(cwd);
        return { ready: cwd === workspaceCwd };
      },
      createBridge: (_resolved, cwd) => {
        bridgeCwd = cwd;
        return { execute: execute as any };
      },
    });

    const before = handlers.get("before_agent_start")?.[0];
    expect(before).toBeDefined();
    if (!before) throw new Error("missing before_agent_start handler");

    const result = await before({ systemPrompt: ["base"], sessionId: "workspace-ready" }, { cwd: workspaceCwd });
    const prompt = promptText(result);

    expect(snapshotCwds).toEqual([workspaceCwd]);
    expect(bridgeCwd).toBe(workspaceCwd);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(prompt).toContain("workspace wake");
    expect(prompt).not.toContain("mempalace(action=\"setup\")");
  });

  test("setup guidance stays stable when MemPalace is not installed", async () => {
    const { platform, handlers } = createHookPlatform();
    registerMempalaceHooks(platform, config(), {
      snapshotInstall: () => ({ ready: false }),
    });
    const before = handlers.get("before_agent_start")![0];

    const first = promptText(await before({ systemPrompt: [], sessionId: "static-guidance" }, { cwd: process.cwd() }));
    const second = promptText(await before({ systemPrompt: [], sessionId: "static-guidance" }, { cwd: process.cwd() }));

    expect(second).toBe(first);
    expect(first).toContain("# MemPalace memory");
  });

  test("session_switch evicts only the affected session cache entries", async () => {
    _resetMempalaceHookState();
    const { platform, handlers } = createHookPlatform();
    const execute = mock(async () => ({ ok: true, action: "wake_up", result: { text: "cached" }, diagnostics: {} }));
    registerMempalaceHooks(platform, config({ budgets: { ...DEFAULT_CONFIG.mempalace.budgets, wakeUpInjectionEvery: 1 } }), readyDeps({
      createBridge: () => ({ execute: execute as any }),
    }));
    const before = handlers.get("before_agent_start")![0];

    await before({ systemPrompt: [], sessionId: "switch-a" }, { cwd: process.cwd() });
    await before({ systemPrompt: [], sessionId: "switch-b" }, { cwd: process.cwd() });
    expect(execute).toHaveBeenCalledTimes(2);
    execute.mockClear();

    handlers.get("session_switch")![0]({ sessionId: "switch-a" });
    await before({ systemPrompt: [], sessionId: "switch-b" }, { cwd: process.cwd() });
    expect(execute).not.toHaveBeenCalled();

    await before({ systemPrompt: [], sessionId: "switch-a" }, { cwd: process.cwd() });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test("LRU evicts oldest wake-up entry when cache exceeds cap", async () => {
    _resetMempalaceHookState();
    const { platform, handlers } = createHookPlatform();
    const execute = mock(async () => ({ ok: true, action: "wake_up", result: { text: "lru-test" }, diagnostics: {} }));
    registerMempalaceHooks(platform, config({ budgets: { ...DEFAULT_CONFIG.mempalace.budgets, wakeUpInjectionEvery: 1 } }), readyDeps({
      createBridge: () => ({ execute: execute as any }),
    }));
    const before = handlers.get("before_agent_start")![0];

    const cap = 64;
    for (let i = 0; i < cap; i += 1) {
      await before({ systemPrompt: [], sessionId: `lru-session-${i}` }, { cwd: process.cwd() });
    }
    expect(execute).toHaveBeenCalledTimes(cap);
    execute.mockClear();

    await before({ systemPrompt: [], sessionId: "lru-session-overflow" }, { cwd: process.cwd() });
    expect(execute).toHaveBeenCalledTimes(1);
    execute.mockClear();

    await before({ systemPrompt: [], sessionId: "lru-session-0" }, { cwd: process.cwd() });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe("prompt classifier (shouldAutoSearchPrompt)", () => {
  const SEARCH_CASES: [string, string][] = [
    ["why is foo broken", "search"],
    ["what did we decide about auth", "search"],
    ["remember our caching plan", "search"],
    ["how do retries work?", "search"],
    ["which approach did we choose for rate limiting?", "search"],
    ["do we use JWT or sessions for auth?", "search"],
    ["is the decision documented somewhere?", "search"],
    ["tell me about prior auth decisions", "search"],
    ["what is the current retry strategy", "search"],
    ["when did we move away from polling?", "search"],
  ];

  const SKIP_CASES: [string, string][] = [
    ["fix foo", "skip"],
    ["refactor the bridge", "skip"],
    ["hello", "skip"],
    ["add tests", "skip"],
    ["yes", "skip"],
    ["ok", "skip"],
    ["remove the deprecated endpoint", "skip"],
    ["implement the new auth flow", "skip"],
    ["build the docker image", "skip"],
    ["update the README", "skip"],
  ];

  // Helper: fire before_agent_start and return whether search was called.
  function makeClassifierHarness() {
    const { platform, handlers } = createHookPlatform();
    let searchCalled = false;
    registerMempalaceHooks(platform, config(), readyDeps({
      createBridge: (() => ({
        execute: async (req: any) => {
          if (req.action === "search" || (req.action === "wake_up_and_search" && typeof req.query === "string")) {
            searchCalled = true;
          }
          if (req.action === "wake_up_and_search") {
            return { ok: true, action: "wake_up_and_search", result: { wake: { text: "w" }, search: { results: [] } }, diagnostics: {} };
          }
          return { ok: true, action: req.action, result: { results: [] }, diagnostics: {} };
        },
      })) as any,
    }));
    return {
      check: async (prompt: string) => {
        searchCalled = false;
        await handlers.get("before_agent_start")![0](
          { systemPrompt: [], sessionId: `cls-${Math.random()}`, prompt },
          { cwd: process.cwd() },
        );
        return searchCalled;
      },
    };
  }

  test("search cases trigger auto-search", async () => {
    const { check } = makeClassifierHarness();
    for (const [prompt] of SEARCH_CASES) {
      const fired = await check(prompt);
      expect(fired, `expected search for: "${prompt}"`).toBe(true);
    }
  });

  test("skip cases do not trigger auto-search", async () => {
    const { check } = makeClassifierHarness();
    for (const [prompt] of SKIP_CASES) {
      const fired = await check(prompt);
      expect(fired, `expected no search for: "${prompt}"`).toBe(false);
    }
  });
});

describe("pickHits with configurable floors", () => {
  test("honors autoSearchSimilarityFloor: hit at 0.95 is filtered when floor is 0.99", async () => {
    const { platform, handlers } = createHookPlatform();
    registerMempalaceHooks(platform, config({ budgets: { ...DEFAULT_CONFIG.mempalace.budgets, autoSearchSimilarityFloor: 0.99, autoSearchBm25Floor: 0.99 } }), readyDeps({
      createBridge: ((() => ({
        execute: async (req: any) => {
          if (req.action === "wake_up_and_search") {
            return {
              ok: true,
              action: "wake_up_and_search",
              result: {
                wake: { text: "w" },
                search: {
                  results: [
                    // similarity 0.95 < floor 0.99; bm25 0.1 < floor 0.99 → should be dropped
                    { text: "hit", source_file: "x.md", room: "r", similarity: 0.95, bm25_score: 0.1 },
                  ],
                },
              },
              diagnostics: {},
            };
          }
          return { ok: false, action: req.action, error: { code: "x", message: "x" }, diagnostics: {} };
        },
      })) as any),
    }));

    const before = handlers.get("before_agent_start")![0];
    const result = await before(
      { systemPrompt: [], sessionId: "floor-test-1", prompt: "what did we decide about caching?" },
      { cwd: process.cwd() },
    );
    // The hit should be filtered out → no Relevant memories block.
    expect(promptText(result)).not.toContain("## Relevant memories");
  });

  test("honors autoSearchSimilarityFloor: hit at 0.96 passes when floor is 0.95", async () => {
    const { platform, handlers } = createHookPlatform();
    registerMempalaceHooks(platform, config({ budgets: { ...DEFAULT_CONFIG.mempalace.budgets, autoSearchSimilarityFloor: 0.95, autoSearchBm25Floor: 0.99 } }), readyDeps({
      createBridge: ((() => ({
        execute: async (req: any) => {
          if (req.action === "wake_up_and_search") {
            return {
              ok: true,
              action: "wake_up_and_search",
              result: {
                wake: { text: "w" },
                search: {
                  results: [
                    { text: "our JWT decision", source_file: "auth.md", room: "auth", similarity: 0.96, bm25_score: 0.1 },
                  ],
                },
              },
              diagnostics: {},
            };
          }
          return { ok: false, action: req.action, error: { code: "x", message: "x" }, diagnostics: {} };
        },
      })) as any),
    }));

    const before = handlers.get("before_agent_start")![0];
    const result = await before(
      { systemPrompt: [], sessionId: "floor-test-2", prompt: "what did we decide about auth?" },
      { cwd: process.cwd() },
    );
    expect(promptText(result)).toContain("## Relevant memories");
  });
});
