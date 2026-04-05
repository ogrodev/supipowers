
import { describe, test, expect, beforeEach } from "bun:test";
import { resolveModelForAction, resolveAllCandidates, applyModelOverride } from "../../src/config/model-resolver.js";
import { ModelActionRegistry } from "../../src/config/model-registry.js";
import type { ModelConfig } from "../../src/types.js";

function makeConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return { version: "1.0.0", default: null, actions: {}, ...overrides };
}

function makePlatformMock(opts: { roleModels?: Record<string, string>; mainModel?: string } = {}) {
  const roleModels = opts.roleModels ?? {};
  const mainModel = opts.mainModel ?? "claude-sonnet-4-6";
  return {
    getModelForRole(role: string): string | null { return roleModels[role] ?? null; },
    getCurrentModel(): string { return mainModel; },
  };
}

describe("resolveModelForAction", () => {
  let registry: ModelActionRegistry;

  beforeEach(() => {
    registry = new ModelActionRegistry();
    registry.register({ id: "plan", category: "command", label: "Plan", harnessRoleHint: "plan" });
    registry.register({ id: "implementer", category: "sub-agent", parent: "run", label: "Implementer", harnessRoleHint: "default" });
    registry.register({ id: "review", category: "command", label: "Review", harnessRoleHint: "slow" });
    registry.register({ id: "custom", category: "command", label: "Custom" });
  });

  test("tier 1: returns per-action config when set", () => {
    const config = makeConfig({ actions: { plan: { model: "claude-opus-4-6", thinkingLevel: "high" } } });
    const result = resolveModelForAction("plan", registry, config, makePlatformMock());
    expect(result).toEqual({ model: "claude-opus-4-6", thinkingLevel: "high", source: "action" });
  });

  test("tier 2: falls back to default when action not configured", () => {
    const config = makeConfig({ default: { model: "claude-sonnet-4-6", thinkingLevel: null } });
    const result = resolveModelForAction("plan", registry, config, makePlatformMock());
    expect(result).toEqual({ model: "claude-sonnet-4-6", thinkingLevel: null, source: "default" });
  });

  test("tier 3: falls back to harness role when no config", () => {
    const config = makeConfig();
    const platform = makePlatformMock({ roleModels: { plan: "claude-opus-4-6" } });
    const result = resolveModelForAction("plan", registry, config, platform);
    expect(result).toEqual({ model: "claude-opus-4-6", thinkingLevel: null, source: "harness-role" });
  });

  test("tier 3: uses harnessRoleHint 'slow' for review", () => {
    const config = makeConfig();
    const platform = makePlatformMock({ roleModels: { slow: "claude-opus-4-6" } });
    const result = resolveModelForAction("review", registry, config, platform);
    expect(result.model).toBe("claude-opus-4-6");
    expect(result.source).toBe("harness-role");
  });

  test("tier 3: defaults to 'default' role when no harnessRoleHint", () => {
    const config = makeConfig();
    const platform = makePlatformMock({ roleModels: { default: "claude-haiku-4-5" } });
    const result = resolveModelForAction("custom", registry, config, platform);
    expect(result.model).toBe("claude-haiku-4-5");
    expect(result.source).toBe("harness-role");
  });

  test("tier 4: falls back to main model when nothing configured", () => {
    const config = makeConfig();
    const platform = makePlatformMock({ mainModel: "claude-sonnet-4-6" });
    const result = resolveModelForAction("plan", registry, config, platform);
    expect(result).toEqual({ model: "claude-sonnet-4-6", thinkingLevel: null, source: "main" });
  });

  test("skips tiers with empty values", () => {
    const config = makeConfig({ default: { model: "claude-sonnet-4-6", thinkingLevel: null }, actions: {} });
    const result = resolveModelForAction("implementer", registry, config, makePlatformMock());
    expect(result.source).toBe("default");
  });

  test("resolves unregistered action using tier 2/3/4 only", () => {
    const config = makeConfig({ default: { model: "claude-sonnet-4-6", thinkingLevel: null } });
    const result = resolveModelForAction("unknown-action", registry, config, makePlatformMock());
    expect(result.source).toBe("default");
  });

  test("resolves unregistered action to main model when no config", () => {
    const config = makeConfig();
    const result = resolveModelForAction("unknown-action", registry, config, makePlatformMock({ mainModel: "claude-haiku-4-5" }));
    expect(result.model).toBe("claude-haiku-4-5");
    expect(result.source).toBe("main");
  });
});

describe("resolveAllCandidates", () => {
  let registry: ModelActionRegistry;

  beforeEach(() => {
    registry = new ModelActionRegistry();
    registry.register({ id: "plan", category: "command", label: "Plan", harnessRoleHint: "plan" });
  });

  test("returns full fallback chain in priority order", () => {
    const config = makeConfig({
      default: { model: "claude-sonnet-4-6", thinkingLevel: null },
      actions: { plan: { model: "claude-opus-4-6", thinkingLevel: "high" } },
    });
    const platform = makePlatformMock({ roleModels: { plan: "claude-opus-4-6" }, mainModel: "claude-haiku-4-5" });
    const candidates = resolveAllCandidates("plan", registry, config, platform);
    expect(candidates).toHaveLength(3); // opus deduplicated (action + harness same)
    expect(candidates[0].source).toBe("action");
    expect(candidates[1].source).toBe("default");
    expect(candidates[2].source).toBe("main");
  });

  test("deduplicates same model across tiers", () => {
    const config = makeConfig({
      default: { model: "claude-opus-4-6", thinkingLevel: null },
      actions: { plan: { model: "claude-opus-4-6", thinkingLevel: "high" } },
    });
    const candidates = resolveAllCandidates("plan", registry, config, makePlatformMock({ mainModel: "claude-opus-4-6" }));
    expect(candidates).toHaveLength(1);
    expect(candidates[0].source).toBe("action");
  });

  test("always includes main model as last resort", () => {
    const config = makeConfig();
    const candidates = resolveAllCandidates("plan", registry, config, makePlatformMock({ mainModel: "claude-sonnet-4-6" }));
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    expect(candidates[candidates.length - 1].source).toBe("main");
  });
});


describe("applyModelOverride", () => {
  function makeFakeModel(id: string, provider = "anthropic") {
    return { id, provider, name: id, api: "messages", baseUrl: "https://api.example.com", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  }

  function makeMockPlatform(opts: { setModelResult?: boolean } = {}) {
    const calls: { setModel: any[]; setThinkingLevel: any[] } = { setModel: [], setThinkingLevel: [] };
    const handlers: Record<string, Function[]> = {};
    return {
      platform: {
        name: "omp" as const,
        async setModel(model: any): Promise<boolean> {
          calls.setModel.push(model);
          return opts.setModelResult ?? true;
        },
        setThinkingLevel(level: string, persist?: boolean): void {
          calls.setThinkingLevel.push({ level, persist });
        },
        getModelForRole: () => null,
        getCurrentModel: () => "unknown",
        registerCommand: () => {},
        getCommands: () => [],
        on: (event: string, handler: Function) => {
          (handlers[event] ??= []).push(handler);
        },
        exec: async () => ({ stdout: "", stderr: "", code: 0 }),
        sendMessage: () => {},
        sendUserMessage: () => {},
        getActiveTools: () => [],
        registerMessageRenderer: () => {},
        createAgentSession: async () => ({ subscribe: () => () => {}, prompt: async () => {}, state: { messages: [] }, dispose: async () => {} }),
        paths: { dotDir: ".omp", dotDirDisplay: ".omp", project: () => "", global: () => "", agent: () => "" },
        capabilities: { agentSessions: true, compactionHooks: true, customWidgets: true, registerTool: false },
      } as any,
      calls,
      handlers,
    };
  }

  function makeCtx(model: any, available: any[], ui?: { setStatus?: Function }) {
    return { model, modelRegistry: { getAvailable: () => available }, ui };
  }

  test("skips when source is 'main' (nothing to override)", async () => {
    const { platform, calls } = makeMockPlatform();
    const resolved = { model: "claude-sonnet-4-6", thinkingLevel: null, source: "main" as const };
    const result = await applyModelOverride(platform, {}, "test-action", resolved);
    expect(result).toBe(false);
    expect(calls.setModel).toHaveLength(0);
    expect(calls.setThinkingLevel).toHaveLength(0);
  });

  test("skips entirely when model is undefined", async () => {
    const { platform, calls } = makeMockPlatform();
    const resolved = { model: undefined, thinkingLevel: "high" as const, source: "action" as const };
    const result = await applyModelOverride(platform, {}, "test-action", resolved);
    expect(result).toBe(false);
    expect(calls.setModel).toHaveLength(0);
    expect(calls.setThinkingLevel).toHaveLength(0);
  });

  test("resolves model by bare ID and applies thinking level", async () => {
    const { platform, calls } = makeMockPlatform();
    const fakeModel = makeFakeModel("claude-opus-4-6");
    const currentModel = makeFakeModel("claude-sonnet-4-6");
    const ctx = makeCtx(currentModel, [fakeModel, currentModel]);
    const resolved = { model: "claude-opus-4-6", thinkingLevel: "xhigh" as const, source: "action" as const };

    const result = await applyModelOverride(platform, ctx, "test-action", resolved);

    expect(result).toBe(true);
    expect(calls.setModel).toHaveLength(1);
    expect(calls.setModel[0]).toBe(fakeModel);
    expect(calls.setThinkingLevel).toHaveLength(1);
    expect(calls.setThinkingLevel[0]).toEqual({ level: "xhigh", persist: undefined });
  });

  test("resolves model by qualified provider/id format", async () => {
    const { platform, calls } = makeMockPlatform();
    const fakeModel = makeFakeModel("claude-opus-4-6", "anthropic");
    const ctx = makeCtx(null, [fakeModel]);
    const resolved = { model: "anthropic/claude-opus-4-6", thinkingLevel: null, source: "action" as const };

    const result = await applyModelOverride(platform, ctx, "test-action", resolved);

    expect(result).toBe(true);
    expect(calls.setModel[0]).toBe(fakeModel);
  });

  test("returns false when model not found in available models", async () => {
    const { platform, calls } = makeMockPlatform();
    const ctx = { modelRegistry: { getAvailable: () => [makeFakeModel("claude-sonnet-4-6")] } };
    const resolved = { model: "nonexistent-model", thinkingLevel: null, source: "action" as const };

    const result = await applyModelOverride(platform, ctx, "test-action", resolved);

    expect(result).toBe(false);
    expect(calls.setModel).toHaveLength(0);
  });

  test("returns false when no modelRegistry available (headless)", async () => {
    const { platform, calls } = makeMockPlatform();
    const ctx = {};
    const resolved = { model: "claude-opus-4-6", thinkingLevel: "high" as const, source: "action" as const };

    const result = await applyModelOverride(platform, ctx, "test-action", resolved);

    expect(result).toBe(false);
    // thinkingLevel should still be set
    expect(calls.setThinkingLevel).toHaveLength(1);
  });

  test("applies thinking level even when setModel is unavailable", async () => {
    const calls: any[] = [];
    const platform = {
      name: "omp" as const,
      setThinkingLevel(level: string) { calls.push(level); },
      // no setModel
    } as any;
    const resolved = { model: "claude-opus-4-6", thinkingLevel: "medium" as const, source: "action" as const };

    const result = await applyModelOverride(platform, {}, "test-action", resolved);

    expect(result).toBe(false);
    expect(calls).toEqual(["medium"]);
  });

  test("skips thinking level when null", async () => {
    const { platform, calls } = makeMockPlatform();
    const fakeModel = makeFakeModel("claude-opus-4-6");
    const ctx = makeCtx(null, [fakeModel]);
    const resolved = { model: "claude-opus-4-6", thinkingLevel: null, source: "action" as const };

    await applyModelOverride(platform, ctx, "test-action", resolved);

    expect(calls.setThinkingLevel).toHaveLength(0);
    expect(calls.setModel).toHaveLength(1);
  });

  test("registers agent_end hook to restore original model", async () => {
    const { platform, calls, handlers } = makeMockPlatform();
    const originalModel = makeFakeModel("claude-sonnet-4-6");
    const overrideModel = makeFakeModel("claude-opus-4-6");
    const ctx = makeCtx(originalModel, [overrideModel, originalModel]);
    const resolved = { model: "claude-opus-4-6", thinkingLevel: null, source: "action" as const };

    await applyModelOverride(platform, ctx, "test-action", resolved);

    expect(calls.setModel).toHaveLength(1);
    expect(calls.setModel[0]).toBe(overrideModel);

    // Simulate agent_end — should restore original model
    expect(handlers["agent_end"]).toHaveLength(1);
    await handlers["agent_end"][0]();

    expect(calls.setModel).toHaveLength(2);
    expect(calls.setModel[1]).toBe(originalModel);
  });

  test("restore hook only fires once", async () => {
    const { platform, calls, handlers } = makeMockPlatform();
    const originalModel = makeFakeModel("claude-sonnet-4-6");
    const overrideModel = makeFakeModel("claude-opus-4-6");
    const ctx = makeCtx(originalModel, [overrideModel, originalModel]);
    const resolved = { model: "claude-opus-4-6", thinkingLevel: null, source: "action" as const };

    await applyModelOverride(platform, ctx, "test-action", resolved);
    await handlers["agent_end"][0]();
    await handlers["agent_end"][0](); // second call — should be no-op

    expect(calls.setModel).toHaveLength(2); // override + restore, not 3
  });

  test("always registers agent_end hook to clear status bar", async () => {
    const { platform, handlers } = makeMockPlatform();
    const fakeModel = makeFakeModel("claude-opus-4-6");
    const statusCalls: any[] = [];
    const ctx = makeCtx(undefined, [fakeModel], { setStatus: (...args: any[]) => statusCalls.push(args) });
    const resolved = { model: "claude-opus-4-6", thinkingLevel: null, source: "action" as const };

    await applyModelOverride(platform, ctx, "test-action", resolved);

    // Hook registered even without originalModel (needed to clear status)
    expect(handlers["agent_end"]).toHaveLength(1);
    await handlers["agent_end"][0]();
    // Status cleared, but no model restore (no original)
    expect(statusCalls.some((c: any[]) => c[1] === undefined)).toBe(true);
  });

  test("sets status bar with model name and source on success", async () => {
    const { platform } = makeMockPlatform();
    const fakeModel = makeFakeModel("claude-opus-4-6");
    const statusCalls: any[] = [];
    const ctx = makeCtx(null, [fakeModel], { setStatus: (...args: any[]) => statusCalls.push(args) });
    const resolved = { model: "claude-opus-4-6", thinkingLevel: null, source: "action" as const };

    await applyModelOverride(platform, ctx, "review", resolved);

    const setCall = statusCalls.find((c: any[]) => c[1] !== undefined);
    expect(setCall).toBeDefined();
    expect(setCall[1]).toContain("claude-opus-4-6");
    expect(setCall[1]).toContain("configured for review");
  });

  test("status bar includes thinking level when set", async () => {
    const { platform } = makeMockPlatform();
    const fakeModel = makeFakeModel("claude-opus-4-6");
    const statusCalls: any[] = [];
    const ctx = makeCtx(null, [fakeModel], { setStatus: (...args: any[]) => statusCalls.push(args) });
    const resolved = { model: "claude-opus-4-6", thinkingLevel: "high" as const, source: "default" as const };

    await applyModelOverride(platform, ctx, "plan", resolved);

    const setCall = statusCalls.find((c: any[]) => c[1] !== undefined);
    expect(setCall[1]).toContain("supipowers default");
    expect(setCall[1]).toContain("high thinking");
  });

  test("status bar shows harness role source", async () => {
    const { platform } = makeMockPlatform();
    const fakeModel = makeFakeModel("claude-opus-4-6");
    const statusCalls: any[] = [];
    const ctx = makeCtx(null, [fakeModel], { setStatus: (...args: any[]) => statusCalls.push(args) });
    const resolved = { model: "claude-opus-4-6", thinkingLevel: null, source: "harness-role" as const };

    await applyModelOverride(platform, ctx, "qa", resolved);

    const setCall = statusCalls.find((c: any[]) => c[1] !== undefined);
    expect(setCall[1]).toContain("harness role");
  });

  test("no status set when source is 'main' (early return)", async () => {
    const { platform } = makeMockPlatform();
    const statusCalls: any[] = [];
    const ctx = { ui: { setStatus: (...args: any[]) => statusCalls.push(args) } };
    const resolved = { model: "claude-sonnet-4-6", thinkingLevel: null, source: "main" as const };

    await applyModelOverride(platform, ctx, "plan", resolved);

    expect(statusCalls).toHaveLength(0);
  });

  test("no crash when ctx.ui is undefined", async () => {
    const { platform } = makeMockPlatform();
    const fakeModel = makeFakeModel("claude-opus-4-6");
    const ctx = makeCtx(null, [fakeModel]); // no ui
    const resolved = { model: "claude-opus-4-6", thinkingLevel: null, source: "action" as const };

    const result = await applyModelOverride(platform, ctx, "review", resolved);
    expect(result).toBe(true); // succeeds without crashing
  });

  test("agent_end hook clears status bar", async () => {
    const { platform, handlers } = makeMockPlatform();
    const fakeModel = makeFakeModel("claude-opus-4-6");
    const originalModel = makeFakeModel("claude-sonnet-4-6");
    const statusCalls: any[] = [];
    const ctx = makeCtx(originalModel, [fakeModel, originalModel], { setStatus: (...args: any[]) => statusCalls.push(args) });
    const resolved = { model: "claude-opus-4-6", thinkingLevel: null, source: "action" as const };

    await applyModelOverride(platform, ctx, "review", resolved);
    statusCalls.length = 0; // clear the initial set call
    await handlers["agent_end"][0]();

    expect(statusCalls).toHaveLength(1);
    expect(statusCalls[0][1]).toBeUndefined(); // cleared
  });
});