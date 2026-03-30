import { describe, test, expect, beforeEach } from "vitest";
import { resolveModelForAction, resolveAllCandidates } from "../../src/config/model-resolver.js";
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
