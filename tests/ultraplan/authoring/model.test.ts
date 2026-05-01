import { describe, expect, test } from "bun:test";

import {
  AUTHORING_ACTION_REGISTRATIONS,
  ULTRAPLAN_AUTHORING_ACTION_NAMESPACE,
  getAuthoringActionId,
  resolveAuthoringSlotModel,
} from "../../../src/ultraplan/authoring/model.js";
import { ModelActionRegistry } from "../../../src/config/model-registry.js";
import { modelRegistry } from "../../../src/config/model-registry-instance.js";
import type { ModelConfig } from "../../../src/types.js";

function makeConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    version: "1",
    default: null,
    actions: {},
    ...overrides,
  };
}

interface BridgeOpts {
  byRole?: Record<string, string>;
  current?: string;
}

function makeBridge(opts: BridgeOpts = {}) {
  return {
    getModelForRole(role: string): string | null {
      return opts.byRole?.[role] ?? null;
    },
    getCurrentModel(): string {
      return opts.current ?? "harness-default";
    },
  };
}

describe("authoring model — action id construction", () => {
  test("non-researcher slot ignores stack hint", () => {
    expect(getAuthoringActionId("planner")).toBe(`${ULTRAPLAN_AUTHORING_ACTION_NAMESPACE}.planner`);
    expect(getAuthoringActionId("planner", "frontend")).toBe(
      `${ULTRAPLAN_AUTHORING_ACTION_NAMESPACE}.planner`,
    );
  });

  test("researcher slot with stack hint produces parameterised id", () => {
    expect(getAuthoringActionId("researcher", "frontend")).toBe(
      `${ULTRAPLAN_AUTHORING_ACTION_NAMESPACE}.researcher.frontend`,
    );
    expect(getAuthoringActionId("researcher", "backend")).toBe(
      `${ULTRAPLAN_AUTHORING_ACTION_NAMESPACE}.researcher.backend`,
    );
    expect(getAuthoringActionId("researcher", "infrastructure")).toBe(
      `${ULTRAPLAN_AUTHORING_ACTION_NAMESPACE}.researcher.infrastructure`,
    );
  });

  test("researcher slot without stack hint returns the unparameterised id", () => {
    expect(getAuthoringActionId("researcher")).toBe(
      `${ULTRAPLAN_AUTHORING_ACTION_NAMESPACE}.researcher`,
    );
  });
});

describe("authoring model — registry registrations", () => {
  test("ten actions are registered: 7 fixed slots + 3 per-stack researchers", () => {
    expect(AUTHORING_ACTION_REGISTRATIONS.length).toBe(10);
  });

  test("every registration is present in the global modelRegistry", () => {
    for (const action of AUTHORING_ACTION_REGISTRATIONS) {
      expect(modelRegistry.get(action.id)).toBeDefined();
    }
  });

  test("researchers all share the `research` harness role hint", () => {
    const researchers = AUTHORING_ACTION_REGISTRATIONS.filter((a) => a.id.includes(".researcher."));
    expect(researchers.length).toBe(3);
    for (const r of researchers) {
      expect(r.harnessRoleHint).toBe("research");
    }
  });

  test("planner uses architect role hint, checkers use review", () => {
    const planner = AUTHORING_ACTION_REGISTRATIONS.find((a) => a.id.endsWith(".planner"))!;
    expect(planner.harnessRoleHint).toBe("architect");

    const checkers = AUTHORING_ACTION_REGISTRATIONS.filter((a) => a.id.endsWith("-checker"));
    expect(checkers.length).toBe(3);
    for (const c of checkers) expect(c.harnessRoleHint).toBe("review");
  });
});

describe("authoring model — resolveAuthoringSlotModel four-tier fallback", () => {
  // Note: the helper resolves through `resolveModelForAction`, which inspects the registry by
  // action id. We reuse the global registry because action ids are registered at module load.

  test("Tier 1: per-action override wins over default and harness role", () => {
    const config = makeConfig({
      default: { model: "default-model", thinkingLevel: "low" },
      actions: {
        [getAuthoringActionId("researcher", "backend")]: {
          model: "backend-researcher-model",
          thinkingLevel: "high",
        },
      },
    });
    const bridge = makeBridge({ byRole: { research: "harness-research-model" } });

    const resolved = resolveAuthoringSlotModel("researcher", "backend", config, modelRegistry, bridge);
    expect(resolved.model).toBe("backend-researcher-model");
    expect(resolved.thinkingLevel).toBe("high");
    expect(resolved.source).toBe("action");
  });

  test("Per-stack overrides do not leak across stacks (backend override does not affect frontend)", () => {
    const config = makeConfig({
      default: null,
      actions: {
        [getAuthoringActionId("researcher", "backend")]: {
          model: "backend-only-model",
          thinkingLevel: null,
        },
      },
    });
    const bridge = makeBridge({ byRole: { research: "harness-research-model" } });

    const backend = resolveAuthoringSlotModel("researcher", "backend", config, modelRegistry, bridge);
    const frontend = resolveAuthoringSlotModel("researcher", "frontend", config, modelRegistry, bridge);
    const infra = resolveAuthoringSlotModel("researcher", "infrastructure", config, modelRegistry, bridge);

    expect(backend.model).toBe("backend-only-model");
    expect(backend.source).toBe("action");
    expect(frontend.model).toBe("harness-research-model");
    expect(frontend.source).toBe("harness-role");
    expect(infra.model).toBe("harness-research-model");
    expect(infra.source).toBe("harness-role");
  });

  test("Tier 2: default applies when no per-action override is set", () => {
    const config = makeConfig({
      default: { model: "supi-default", thinkingLevel: "medium" },
    });
    const bridge = makeBridge({ byRole: { architect: "should-not-be-used" } });

    const resolved = resolveAuthoringSlotModel("planner", null, config, modelRegistry, bridge);
    expect(resolved.model).toBe("supi-default");
    expect(resolved.source).toBe("default");
  });

  test("Tier 3: harness role hint is used when no override and no default", () => {
    const config = makeConfig();
    const bridge = makeBridge({ byRole: { architect: "harness-architect" } });

    const resolved = resolveAuthoringSlotModel("planner", null, config, modelRegistry, bridge);
    expect(resolved.model).toBe("harness-architect");
    expect(resolved.source).toBe("harness-role");
  });

  test("Tier 4: main session model is the final fallback", () => {
    const config = makeConfig();
    const bridge = makeBridge({ current: "main-session-model" });

    const resolved = resolveAuthoringSlotModel("planner", null, config, modelRegistry, bridge);
    expect(resolved.model).toBe("main-session-model");
    expect(resolved.source).toBe("main");
  });
});

describe("authoring model — fresh registry parity", () => {
  // Ensure that the registrations would behave identically with a brand-new registry. We
  // build a copy and re-register manually so the test does not rely on module-load order.
  test("a fresh registry resolves the same per-stack action ids", () => {
    const fresh = new ModelActionRegistry();
    for (const action of AUTHORING_ACTION_REGISTRATIONS) {
      fresh.register({
        id: action.id,
        category: "sub-agent",
        parent: "ultraplan",
        label: action.label,
        harnessRoleHint: action.harnessRoleHint,
      });
    }
    expect(fresh.get(getAuthoringActionId("researcher", "frontend"))).toBeDefined();
    expect(fresh.get(getAuthoringActionId("researcher", "backend"))).toBeDefined();
    expect(fresh.get(getAuthoringActionId("researcher", "infrastructure"))).toBeDefined();
    expect(fresh.get(getAuthoringActionId("planner"))).toBeDefined();
    expect(fresh.get(getAuthoringActionId("structure-checker"))).toBeDefined();
  });
});
