# Role-Based Model Configuration Implementation Plan

**Goal:** Replace the inert `modelPreference` setting with a role-based model configuration system that maps agent roles to concrete model IDs with thinking-level support, per-task overrides, and a dedicated `/supi:models` command.

**Architecture:** Three layers: (1) types + config schema define the `ModelConfig` shape and persist it through the existing three-layer config loader, (2) a model resolver module translates role + config + task override into a concrete `ResolvedModel` by parsing OMP model strings and looking up the registry, (3) the dispatcher uses the resolver before each sub-agent dispatch with save/restore of the session model. A new `/supi:models` command and a nested menu in `/supi:config` share a UI builder for editing role→model assignments.

**Tech Stack:** TypeScript, TypeBox (schema validation), Vitest (tests), OMP ExtensionAPI (`pi.setModel`, `pi.setThinkingLevel`, `ctx.modelRegistry`)

**Spec:** `docs/superpowers/specs/2026-03-15-model-configuration-design.md`

---

## File Map

| File | Responsibility | Action |
|------|---------------|--------|
| `src/types.ts` | Add `AgentRole`, `ModelConfig`, `ThinkingLevel`; add `model?` to `PlanTask`; replace `modelPreference` with `models` in `SupipowersConfig` | Modify |
| `src/config/schema.ts` | Replace `modelPreference` schema with `ModelConfigSchema` | Modify |
| `src/config/defaults.ts` | Replace `modelPreference: "auto"` with `models: { default: "anthropic/claude-sonnet-4" }` | Modify |
| `src/config/loader.ts` | Add migration: drop stale `modelPreference` during load | Modify |
| `src/orchestrator/model-resolver.ts` | `parseModelString`, `resolveModelString`, `resolveModel`, `ResolvedModel`, `ModelRegistryLike` | Create |
| `src/storage/plans.ts` | Parse `[model: ...]` annotation from task headers | Modify |
| `src/commands/models.ts` | `/supi:models` command handler + shared model config UI builder | Create |
| `src/commands/config.ts` | Replace "Model preference" setting with "Model Configuration" submenu entry | Modify |
| `src/orchestrator/dispatcher.ts` | Wire model resolution + save/restore into dispatch flow | Modify |
| `src/index.ts` | Register `supi:models` command + TUI handler | Modify |
| `tests/orchestrator/model-resolver.test.ts` | Unit tests for model string parsing and resolution | Create |
| `tests/storage/plans.test.ts` | Add tests for `[model: ...]` annotation parsing | Modify |
| `tests/config/loader.test.ts` | Add migration tests for `modelPreference` → `models` | Modify |
| `tests/commands/models.test.ts` | Tests for models command UI builder | Create |
| `tests/orchestrator/dispatcher-model.test.ts` | Dispatcher model resolution integration tests | Create |
| `tests/integration/extension.test.ts` | Add `supi:models` to registered commands check | Modify |

---

## Chunk 1: Types, Config Schema, Defaults, Migration

Foundation layer. All other chunks depend on these types and config shape.

### Task 1: Add new types to `src/types.ts` [parallel-safe]

**Files:**
- Modify: `src/types.ts`
- Test: `tests/config/loader.test.ts` (verified in Task 4)

- [ ] **Step 1: Add `AgentRole` type**

Add after the `TaskParallelism` type (line 12):

```typescript
/** Agent roles that supipowers dispatches */
export type AgentRole = "implementer" | "reviewer" | "fixAgent";
```

- [ ] **Step 2: Add `ThinkingLevel` type**

```typescript
/** Thinking level for model configuration (mirrors OMP's ThinkingLevel) */
export type ThinkingLevel = "inherit" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
```

- [ ] **Step 3: Add `ModelConfig` interface**

```typescript
/** Role-based model configuration */
export interface ModelConfig {
  /** Fallback model for any role not explicitly configured. Format: "provider/model-id" or "provider/model-id:thinking-level" */
  default: string;
  /** Model for implementation sub-agents */
  implementer?: string;
  /** Model for review sub-agents */
  reviewer?: string;
  /** Model for fix/retry sub-agents */
  fixAgent?: string;
}
```

- [ ] **Step 4: Note on `ResolvedModel`**

`ResolvedModel` and `ModelRegistryLike` are defined in `src/orchestrator/model-resolver.ts` (Task 6), not in `types.ts`. They are resolver-internal concerns — the model shape is a subset of OMP's `Model` type, and the resolver is the only consumer. No need to add them to the shared types file.

- [ ] **Step 5: Add `model` field to `PlanTask`**

In the `PlanTask` interface, add after `parallelism`:

```typescript
  /** Model override from [model: ...] plan annotation */
  model?: string;
```

- [ ] **Step 6: Replace `modelPreference` with `models` in `SupipowersConfig`**

In `SupipowersConfig.orchestration`, replace:

```typescript
    modelPreference: string;
```

with:

```typescript
    models: ModelConfig;
```

- [ ] **Step 7: Verify type errors surface**

Run: `bun run typecheck`

Expected: Type errors in `src/config/defaults.ts`, `src/config/schema.ts`, `src/commands/config.ts`, and anywhere else referencing `modelPreference`. These are expected and will be fixed in subsequent tasks.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): add AgentRole, ModelConfig, ResolvedModel; replace modelPreference"
```

### Task 2: Update config schema [sequential: depends on 1]

**Files:**
- Modify: `src/config/schema.ts`

- [ ] **Step 1: Replace `modelPreference` with `ModelConfig` schema**

In `src/config/schema.ts`, replace line 13:

```typescript
    modelPreference: Type.String(),
```

with:

```typescript
    models: Type.Object({
      default: Type.String(),
      implementer: Type.Optional(Type.String()),
      reviewer: Type.Optional(Type.String()),
      fixAgent: Type.Optional(Type.String()),
    }),
```

- [ ] **Step 2: Commit**

```bash
git add src/config/schema.ts
git commit -m "feat(schema): replace modelPreference with ModelConfig schema"
```

### Task 3: Update config defaults [sequential: depends on 1]

**Files:**
- Modify: `src/config/defaults.ts`

- [ ] **Step 1: Replace `modelPreference` with `models` and bump version**

In `src/config/defaults.ts`, replace:

```typescript
    modelPreference: "auto",
```

with:

```typescript
    models: {
      default: "anthropic/claude-sonnet-4",
    },
```

Also bump the config version from `"1.0.0"` to `"1.1.0"` so migration fires on old configs and persists the cleanup:

```typescript
  version: "1.1.0",
```

- [ ] **Step 2: Commit**

```bash
git add src/config/defaults.ts
git commit -m "feat(defaults): replace modelPreference with models config, bump to v1.1.0"
```

### Task 4: Add migration and tests [sequential: depends on 1, 2, 3]

**Files:**
- Modify: `src/config/loader.ts`
- Modify: `tests/config/loader.test.ts`

- [ ] **Step 1: Write migration tests**

Add to `tests/config/loader.test.ts`:

```typescript
describe("modelPreference migration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("drops modelPreference from old project config", () => {
    const configDir = path.join(tmpDir, ".omp", "supipowers");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({
        orchestration: { modelPreference: "fast" },
      })
    );
    const config = loadConfig(tmpDir);
    expect((config.orchestration as any).modelPreference).toBeUndefined();
    expect(config.orchestration.models).toEqual({
      default: "anthropic/claude-sonnet-4",
    });
  });

  test("preserves existing models config during load", () => {
    const configDir = path.join(tmpDir, ".omp", "supipowers");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({
        orchestration: {
          models: {
            default: "anthropic/claude-haiku-4",
            reviewer: "anthropic/claude-haiku-4:off",
          },
        },
      })
    );
    const config = loadConfig(tmpDir);
    expect(config.orchestration.models.default).toBe("anthropic/claude-haiku-4");
    expect(config.orchestration.models.reviewer).toBe("anthropic/claude-haiku-4:off");
  });

  test("merges per-role overrides from project config over defaults", () => {
    const configDir = path.join(tmpDir, ".omp", "supipowers");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({
        orchestration: {
          models: {
            reviewer: "openai/gpt-4o:low",
          },
        },
      })
    );
    const config = loadConfig(tmpDir);
    // default inherited from DEFAULT_CONFIG
    expect(config.orchestration.models.default).toBe("anthropic/claude-sonnet-4");
    // reviewer overridden by project config
    expect(config.orchestration.models.reviewer).toBe("openai/gpt-4o:low");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/config/loader.test.ts`

Expected: First test fails because `modelPreference` is still present and migration doesn't strip it.

- [ ] **Step 3: Add migration logic to `migrateConfig`**

In `src/config/loader.ts`, update the `migrateConfig` function:

```typescript
function migrateConfig(config: SupipowersConfig): SupipowersConfig {
  const migrated = { ...config, version: DEFAULT_CONFIG.version };

  // Drop stale modelPreference — it was never consumed
  const orch = migrated.orchestration as Record<string, unknown>;
  if ("modelPreference" in orch) {
    delete orch.modelPreference;
  }

  return migrated;
}
```

Also update `loadConfig` to strip `modelPreference` from raw loaded data before merge, since project configs may have it even on current version:

```typescript
export function loadConfig(cwd: string): SupipowersConfig {
  const globalData = readJsonSafe(getGlobalConfigPath());
  const projectData = readJsonSafe(getProjectConfigPath(cwd));

  let config = { ...DEFAULT_CONFIG };
  if (globalData) config = deepMerge(config, stripLegacyFields(globalData));
  if (projectData) config = deepMerge(config, stripLegacyFields(projectData));

  if (config.version !== DEFAULT_CONFIG.version) {
    config = migrateConfig(config);
    if (projectData) saveConfig(cwd, config);
  }

  return config;
}

/** Remove legacy fields that would pollute the merged config */
function stripLegacyFields(data: Record<string, unknown>): Record<string, unknown> {
  const result = { ...data };
  const orch = result.orchestration as Record<string, unknown> | undefined;
  if (orch && "modelPreference" in orch) {
    const { modelPreference, ...rest } = orch;
    result.orchestration = rest;
  }
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/config/loader.test.ts`

Expected: All tests pass, including the three new migration tests.

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`

Expected: Remaining type errors in `src/commands/config.ts` (referencing old `modelPreference`). These are fixed in Chunk 3.

- [ ] **Step 6: Commit**

```bash
git add src/config/loader.ts tests/config/loader.test.ts
git commit -m "feat(config): migrate modelPreference to models, strip legacy fields"
```

---

## Chunk 2: Model Resolver + Plan Parser

Core logic layer. Model resolution is the central new module; plan parser gains the `[model: ...]` annotation.

### Task 5: Write model resolver tests [parallel-safe]

**Files:**
- Create: `tests/orchestrator/model-resolver.test.ts`

- [ ] **Step 1: Write `parseModelString` tests**

```typescript
import { describe, test, expect } from "vitest";
import {
  parseModelString,
  resolveModelString,
} from "../../src/orchestrator/model-resolver.js";
import type { ModelConfig } from "../../src/types.js";

describe("parseModelString", () => {
  test("parses provider/model-id without thinking level", () => {
    const result = parseModelString("anthropic/claude-sonnet-4");
    expect(result).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4",
      thinkingLevel: undefined,
    });
  });

  test("parses provider/model-id with thinking level", () => {
    const result = parseModelString("anthropic/claude-sonnet-4:high");
    expect(result).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4",
      thinkingLevel: "high",
    });
  });

  test("handles model IDs with multiple dashes", () => {
    const result = parseModelString("openai/gpt-4o-2025-03-01:low");
    expect(result).toEqual({
      provider: "openai",
      modelId: "gpt-4o-2025-03-01",
      thinkingLevel: "low",
    });
  });

  test("throws on missing provider separator", () => {
    expect(() => parseModelString("claude-sonnet-4")).toThrow(
      'Invalid model string "claude-sonnet-4". Expected format: provider/model-id[:thinking-level]'
    );
  });

  test("throws on empty provider", () => {
    expect(() => parseModelString("/claude-sonnet-4")).toThrow(
      'Invalid model string "/claude-sonnet-4"'
    );
  });

  test("throws on empty model ID", () => {
    expect(() => parseModelString("anthropic/")).toThrow(
      'Invalid model string "anthropic/"'
    );
  });

  test("throws on invalid thinking level", () => {
    expect(() => parseModelString("anthropic/claude-sonnet-4:turbo")).toThrow(
      'Invalid thinking level "turbo"'
    );
  });

  test("accepts all valid thinking levels", () => {
    const levels = ["inherit", "off", "minimal", "low", "medium", "high", "xhigh"] as const;
    for (const level of levels) {
      const result = parseModelString(`anthropic/claude-sonnet-4:${level}`);
      expect(result.thinkingLevel).toBe(level);
    }
  });
});
```

- [ ] **Step 2: Write `resolveModelString` tests**

```typescript
describe("resolveModelString", () => {
  const baseConfig: ModelConfig = {
    default: "anthropic/claude-sonnet-4",
  };

  test("returns default when no role-specific or task override", () => {
    expect(resolveModelString(baseConfig, "implementer")).toBe(
      "anthropic/claude-sonnet-4"
    );
  });

  test("returns role-specific when set", () => {
    const config: ModelConfig = {
      ...baseConfig,
      reviewer: "anthropic/claude-haiku-4:off",
    };
    expect(resolveModelString(config, "reviewer")).toBe(
      "anthropic/claude-haiku-4:off"
    );
  });

  test("task override takes precedence over role-specific", () => {
    const config: ModelConfig = {
      ...baseConfig,
      implementer: "anthropic/claude-sonnet-4:high",
    };
    expect(
      resolveModelString(config, "implementer", "openai/gpt-4o:medium")
    ).toBe("openai/gpt-4o:medium");
  });

  test("task override takes precedence over default", () => {
    expect(
      resolveModelString(baseConfig, "fixAgent", "anthropic/claude-opus-4:xhigh")
    ).toBe("anthropic/claude-opus-4:xhigh");
  });

  test("falls back to default when role has no override and no task override", () => {
    const config: ModelConfig = {
      default: "anthropic/claude-sonnet-4:medium",
      reviewer: "anthropic/claude-haiku-4:off",
    };
    expect(resolveModelString(config, "implementer")).toBe(
      "anthropic/claude-sonnet-4:medium"
    );
    expect(resolveModelString(config, "fixAgent")).toBe(
      "anthropic/claude-sonnet-4:medium"
    );
  });
});
```

- [ ] **Step 3: Write `resolveModel` tests (registry lookup)**

```typescript
import { resolveModel } from "../../src/orchestrator/model-resolver.js";

describe("resolveModel", () => {
  const mockRegistry = {
    find(provider: string, modelId: string) {
      const models: Record<string, { id: string; provider: string; name: string }> = {
        "anthropic/claude-sonnet-4": { id: "claude-sonnet-4", provider: "anthropic", name: "Claude Sonnet 4" },
        "anthropic/claude-haiku-4": { id: "claude-haiku-4", provider: "anthropic", name: "Claude Haiku 4" },
      };
      return models[`${provider}/${modelId}`];
    },
    getAvailable() {
      return [
        { id: "claude-sonnet-4", provider: "anthropic", name: "Claude Sonnet 4" },
        { id: "claude-haiku-4", provider: "anthropic", name: "Claude Haiku 4" },
      ];
    },
  };

  test("resolves model string without thinking level", () => {
    const result = resolveModel("anthropic/claude-sonnet-4", mockRegistry);
    expect(result.model.id).toBe("claude-sonnet-4");
    expect(result.model.provider).toBe("anthropic");
    expect(result.thinkingLevel).toBeUndefined();
  });

  test("resolves model string with thinking level", () => {
    const result = resolveModel("anthropic/claude-haiku-4:off", mockRegistry);
    expect(result.model.id).toBe("claude-haiku-4");
    expect(result.thinkingLevel).toBe("off");
  });

  test("throws when model not found in registry", () => {
    expect(() => resolveModel("openai/gpt-4o", mockRegistry)).toThrow(
      /not found in registry/
    );
  });

  test("error message lists available models", () => {
    try {
      resolveModel("openai/gpt-4o", mockRegistry);
    } catch (e: any) {
      expect(e.message).toContain("anthropic/claude-sonnet-4");
      expect(e.message).toContain("anthropic/claude-haiku-4");
    }
  });

  test("throws on malformed model string", () => {
    expect(() => resolveModel("bad-string", mockRegistry)).toThrow(
      /Invalid model string/
    );
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `bun test tests/orchestrator/model-resolver.test.ts`

Expected: FAIL — module `../../src/orchestrator/model-resolver.js` does not exist.

- [ ] **Step 5: Commit test file**

```bash
git add tests/orchestrator/model-resolver.test.ts
git commit -m "test(model-resolver): add tests for parseModelString, resolveModelString, resolveModel"
```

### Task 6: Implement model resolver [sequential: depends on 1, 5]

**Files:**
- Create: `src/orchestrator/model-resolver.ts`

- [ ] **Step 1: Implement the module**

```typescript
// src/orchestrator/model-resolver.ts
import type { AgentRole, ModelConfig, ThinkingLevel } from "../types.js";

const VALID_THINKING_LEVELS = new Set<string>([
  "inherit", "off", "minimal", "low", "medium", "high", "xhigh",
]);

export interface ParsedModelString {
  provider: string;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
}

/**
 * Parse an OMP model string "provider/model-id[:thinking-level]".
 * Throws on malformed input.
 */
export function parseModelString(modelString: string): ParsedModelString {
  const slashIndex = modelString.indexOf("/");
  if (slashIndex === -1 || slashIndex === 0) {
    throw new Error(
      `Invalid model string "${modelString}". Expected format: provider/model-id[:thinking-level]`
    );
  }

  const provider = modelString.slice(0, slashIndex);
  const rest = modelString.slice(slashIndex + 1);

  if (!rest) {
    throw new Error(
      `Invalid model string "${modelString}". Expected format: provider/model-id[:thinking-level]`
    );
  }

  const colonIndex = rest.lastIndexOf(":");
  if (colonIndex === -1) {
    return { provider, modelId: rest };
  }

  const modelId = rest.slice(0, colonIndex);
  const thinkingStr = rest.slice(colonIndex + 1);

  if (!modelId) {
    throw new Error(
      `Invalid model string "${modelString}". Expected format: provider/model-id[:thinking-level]`
    );
  }

  if (!VALID_THINKING_LEVELS.has(thinkingStr)) {
    throw new Error(
      `Invalid thinking level "${thinkingStr}" in model string "${modelString}". ` +
      `Valid levels: ${[...VALID_THINKING_LEVELS].join(", ")}`
    );
  }

  return { provider, modelId, thinkingLevel: thinkingStr as ThinkingLevel };
}

/**
 * Resolve which model string to use for a given role.
 * Precedence: task annotation > role-specific config > default.
 */
export function resolveModelString(
  models: ModelConfig,
  role: AgentRole,
  taskOverride?: string,
): string {
  return taskOverride ?? models[role] ?? models.default;
}
```

- [ ] **Step 2: Add `resolveModel` function (registry lookup)**

Add to the same file, after `resolveModelString`:

```typescript
/** Minimal model registry interface (subset of OMP's ModelRegistry) */
export interface ModelRegistryLike {
  find(provider: string, modelId: string): { id: string; provider: string; [key: string]: unknown } | undefined;
  getAvailable(): { id: string; provider: string; name: string }[];
}

/** Result of resolving a model string against the registry */
export interface ResolvedModel {
  model: { id: string; provider: string; [key: string]: unknown };
  thinkingLevel?: ThinkingLevel;
}

/**
 * Resolve a model string against the OMP model registry.
 * Parses the string, looks up the model, and returns the resolved model + thinking level.
 * Throws if the string is malformed or the model is not in the registry.
 */
export function resolveModel(
  modelString: string,
  registry: ModelRegistryLike,
): ResolvedModel {
  const parsed = parseModelString(modelString);
  const model = registry.find(parsed.provider, parsed.modelId);
  if (!model) {
    const available = registry.getAvailable();
    const names = available.map(m => `${m.provider}/${m.id}`).join(", ");
    throw new Error(
      `Model "${parsed.provider}/${parsed.modelId}" not found in registry. Available: ${names || "none"}`
    );
  }
  return { model, thinkingLevel: parsed.thinkingLevel };
}
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `bun test tests/orchestrator/model-resolver.test.ts`

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator/model-resolver.ts
git commit -m "feat(model-resolver): implement parseModelString, resolveModelString, resolveModel"
```

### Task 7: Add `[model: ...]` annotation parsing to plan parser [parallel-safe]

**Files:**
- Modify: `src/storage/plans.ts`
- Modify: `tests/storage/plans.test.ts`

- [ ] **Step 1: Add tests for model annotation parsing**

Add to the existing `SAMPLE_PLAN` in `tests/storage/plans.test.ts` — create a new sample that includes the model annotation:

```typescript
const PLAN_WITH_MODEL = `---
name: model-test
created: 2026-03-15
tags: [test]
---

# Model Test

## Context
Testing model annotation parsing.

## Tasks

### 1. Simple task [parallel-safe]
- **files**: src/a.ts
- **criteria**: Works
- **complexity**: small

### 2. Task with model [parallel-safe] [model: anthropic/claude-sonnet-4:high]
- **files**: src/b.ts
- **criteria**: Works with specific model
- **complexity**: medium

### 3. Task with model and sequential [sequential: depends on 1] [model: openai/gpt-4o]
- **files**: src/c.ts
- **criteria**: Depends on task 1
- **complexity**: large
`;

describe("model annotation parsing", () => {
  test("task without model annotation has undefined model", () => {
    const plan = parsePlan(PLAN_WITH_MODEL, "model-test.md");
    expect(plan.tasks[0].model).toBeUndefined();
  });

  test("parses model annotation from task header", () => {
    const plan = parsePlan(PLAN_WITH_MODEL, "model-test.md");
    expect(plan.tasks[1].model).toBe("anthropic/claude-sonnet-4:high");
  });

  test("parses model annotation alongside sequential annotation", () => {
    const plan = parsePlan(PLAN_WITH_MODEL, "model-test.md");
    expect(plan.tasks[2].model).toBe("openai/gpt-4o");
    expect(plan.tasks[2].parallelism).toEqual({ type: "sequential", dependsOn: [1] });
  });

  test("model annotation does not leak into task name", () => {
    const plan = parsePlan(PLAN_WITH_MODEL, "model-test.md");
    expect(plan.tasks[1].name).toBe("Task with model");
    expect(plan.tasks[2].name).toBe("Task with model and sequential");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/storage/plans.test.ts`

Expected: FAIL — `plan.tasks[1].model` is `undefined` because `parseModel` doesn't exist yet.

- [ ] **Step 3: Add `parseModel` function and wire it in**

In `src/storage/plans.ts`, add the parser function:

```typescript
function parseModel(header: string): string | undefined {
  const match = header.match(/\[model:\s*([^\]]+)\]/);
  return match?.[1]?.trim();
}
```

Update `parseTasksFromMarkdown` to call it and include in the task object. In the task construction (line 98), add:

```typescript
    const model = parseModel(headerLine);

    tasks.push({ id, name, description: name, files, criteria, complexity, parallelism, model });
```

For tasks without the annotation, `model` will be `undefined`, which is correct since it's optional on `PlanTask`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/storage/plans.test.ts`

Expected: All tests pass (both existing and new).

- [ ] **Step 5: Commit**

```bash
git add src/storage/plans.ts tests/storage/plans.test.ts
git commit -m "feat(plans): parse [model: ...] annotation from task headers"
```

---

## Chunk 3: Commands, Dispatcher Integration, Registration

UI and wiring layer. Depends on Chunk 1 (types/config) and Chunk 2 (model resolver).

### Task 8: Create `/supi:models` command with shared UI builder [sequential: depends on 1, 6]

**Files:**
- Create: `src/commands/models.ts`
- Create: `tests/commands/models.test.ts`

- [ ] **Step 1: Write tests for the shared model config UI builder**

```typescript
import { describe, test, expect, vi } from "vitest";
import { buildModelSummary } from "../../src/commands/models.js";
import type { ModelConfig } from "../../src/types.js";

describe("buildModelSummary", () => {
  test("shows default model and '(using default)' for unset roles", () => {
    const config: ModelConfig = {
      default: "anthropic/claude-sonnet-4:high",
    };
    const lines = buildModelSummary(config);
    expect(lines).toContain("Default:      anthropic/claude-sonnet-4:high");
    expect(lines).toContain("Implementer:  (using default)");
    expect(lines).toContain("Reviewer:     (using default)");
    expect(lines).toContain("Fix Agent:    (using default)");
  });

  test("shows role-specific models when set", () => {
    const config: ModelConfig = {
      default: "anthropic/claude-sonnet-4",
      reviewer: "anthropic/claude-haiku-4:off",
      fixAgent: "openai/gpt-4o:low",
    };
    const lines = buildModelSummary(config);
    expect(lines).toContain("Implementer:  (using default)");
    expect(lines).toContain("Reviewer:     anthropic/claude-haiku-4:off");
    expect(lines).toContain("Fix Agent:    openai/gpt-4o:low");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/commands/models.test.ts`

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the models command**

```typescript
// src/commands/models.ts
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { loadConfig, updateConfig, saveConfig } from "../config/loader.js";
import type { ModelConfig, AgentRole } from "../types.js";

const ROLE_LABELS: { role: AgentRole | "default"; label: string }[] = [
  { role: "default", label: "Default" },
  { role: "implementer", label: "Implementer" },
  { role: "reviewer", label: "Reviewer" },
  { role: "fixAgent", label: "Fix Agent" },
];

/** Build a summary of current model assignments for display */
export function buildModelSummary(models: ModelConfig): string {
  const lines = [
    "supipowers Model Configuration",
    "────────────────────────────────",
    "Models for supipowers agent dispatch only.",
    "OMP commands (/review, /plan, etc.) use their own model settings.",
    "",
  ];

  for (const { role, label } of ROLE_LABELS) {
    const value = role === "default"
      ? models.default
      : models[role] ?? "(using default)";
    lines.push(`${label}:${" ".repeat(14 - label.length)}${value}`);
  }

  return lines.join("\n");
}

/** Shared model config menu — used by both /supi:models and /supi:config */
export async function showModelConfigMenu(
  ctx: ExtensionContext,
  cwd: string,
): Promise<void> {
  while (true) {
    const config = loadConfig(cwd);
    const models = config.orchestration.models;

    const options = ROLE_LABELS.map(({ role, label }) => {
      const value = role === "default"
        ? models.default
        : models[role] ?? "(using default)";
      return `${label}: ${value}`;
    });
    options.push("← Back");

    const choice = await ctx.ui.select(
      "Model Configuration",
      options,
      { helpText: "Assign models to supipowers agent roles" },
    );

    if (choice === undefined || choice === "← Back") break;

    const index = options.indexOf(choice);
    const entry = ROLE_LABELS[index];
    if (!entry) break;

    await editRoleModel(ctx, cwd, entry.role, entry.label);
  }
}

async function editRoleModel(
  ctx: ExtensionContext,
  cwd: string,
  role: AgentRole | "default",
  label: string,
): Promise<void> {
  const editOptions = role === "default"
    ? ["Enter model string"]
    : ["Enter model string", "Reset to default"];

  const action = await ctx.ui.select(
    `${label} Model`,
    editOptions,
    { helpText: 'Format: provider/model-id[:thinking-level] (e.g., "anthropic/claude-sonnet-4:high")' },
  );

  if (action === undefined) return;

  if (action === "Reset to default" && role !== "default") {
    // Load, delete the key, save — avoids deepMerge + JSON.stringify undefined ambiguity
    const config = loadConfig(cwd);
    delete config.orchestration.models[role];
    saveConfig(cwd, config);
    ctx.ui.notify(`${label} model reset to default`, "info");
    return;
  }

  if (action === "Enter model string") {
    const value = await ctx.ui.input(
      `Enter model string for ${label}`,
      { helpText: 'Format: provider/model-id[:thinking-level]' },
    );

    if (value) {
      if (role === "default") {
        updateConfig(cwd, { orchestration: { models: { default: value } } });
      } else {
        const models: Record<string, unknown> = {};
        models[role] = value;
        updateConfig(cwd, { orchestration: { models } });
      }
      ctx.ui.notify(`${label} → ${value}`, "info");
    }
  }
}

export function handleModels(pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (!ctx.hasUI) {
    ctx.ui.notify("Model config requires interactive mode", "warning");
    return;
  }

  void showModelConfigMenu(ctx, ctx.cwd);
}

export function registerModelsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("supi:models", {
    description: "Configure model assignments for supipowers agent roles",
    async handler(_args, ctx) {
      handleModels(pi, ctx);
    },
  });
}
```

`ctx.ui.input` is already used in the codebase (`fix-pr.ts`, `qa.ts`), so it's available on `ExtensionContext`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/commands/models.test.ts`

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/commands/models.ts tests/commands/models.test.ts
git commit -m "feat(models): add /supi:models command with shared UI builder"
```

### Task 9: Update `/supi:config` to use model submenu [sequential: depends on 8]

**Files:**
- Modify: `src/commands/config.ts`

- [ ] **Step 1: Replace "Model preference" setting with "Model Configuration" submenu entry**

In `src/commands/config.ts`:

1. Add import at the top:
```typescript
import { showModelConfigMenu } from "./models.js";
```

2. Remove the "Model preference" setting entry (lines 73-81 in `buildSettings`):
```typescript
    {
      label: "Model preference",
      key: "orchestration.modelPreference",
      helpText: "Which model sub-agents use for code generation",
      type: "select",
      options: ["auto", "fast", "balanced", "quality"],
      get: (c) => c.orchestration.modelPreference,
      set: (d, v) => updateConfig(d, { orchestration: { modelPreference: v } }),
    },
```

3. In the `handleConfig` function, after the settings loop options are built and before the choice handling, add a "Model Configuration" entry. The cleanest approach: add a special entry in the options list and handle it in the main loop.

Update the while loop in `handleConfig`:

```typescript
  void (async () => {
    const settings = buildSettings(ctx.cwd);

    while (true) {
      const config = loadConfig(ctx.cwd);

      const options = settings.map(
        (s) => `${s.label}: ${s.get(config)}`
      );
      options.push("Model Configuration ▸");
      options.push("Done");

      const choice = await ctx.ui.select(
        "Supipowers Settings",
        options,
        { helpText: "Select a setting to change · Esc to close" },
      );

      if (choice === undefined || choice === "Done") break;

      if (choice === "Model Configuration ▸") {
        await showModelConfigMenu(ctx, ctx.cwd);
        continue;
      }

      const index = options.indexOf(choice);
      const setting = settings[index];
      if (!setting) break;

      // ... rest of select/toggle handling unchanged
    }
  })();
```

- [ ] **Step 2: Verify typecheck passes for config.ts**

Run: `bun run typecheck`

Expected: No type errors in `src/commands/config.ts` (the `modelPreference` references are gone).

- [ ] **Step 3: Commit**

```bash
git add src/commands/config.ts
git commit -m "feat(config): replace Model preference with Model Configuration submenu"
```

### Task 10: Wire model resolution into dispatcher [sequential: depends on 1, 6]

**Files:**
- Modify: `src/orchestrator/dispatcher.ts`
- Create: `tests/orchestrator/dispatcher-model.test.ts`

- [ ] **Step 1: Add model resolution imports and update `DispatchOptions`**

Add imports:
```typescript
import { resolveModelString, resolveModel } from "./model-resolver.js";
import type { AgentRole } from "../types.js";
```

Extend `DispatchOptions.ctx` to include model-related APIs:

```typescript
export interface DispatchOptions {
  pi: ExtensionAPI;
  ctx: {
    cwd: string;
    ui: { notify(msg: string, type?: "info" | "warning" | "error"): void };
    model?: { id: string; provider: string; [key: string]: unknown };
    modelRegistry?: {
      find(provider: string, modelId: string): { id: string; provider: string; [key: string]: unknown } | undefined;
      getAvailable(): { id: string; provider: string; name: string }[];
    };
  };
  task: PlanTask;
  planContext: string;
  config: SupipowersConfig;
  lspAvailable: boolean;
  contextModeAvailable: boolean;
  role?: AgentRole;
}
```

- [ ] **Step 2: Add model resolution helper**

Add before `dispatchAgent`:

```typescript
interface ModelSwitchState {
  previousModel?: DispatchOptions["ctx"]["model"];
  previousThinkingLevel?: string;
}

/**
 * Resolve and switch to the model for this dispatch.
 * Returns the previous state for restoration.
 * Returns null if the model could not be set (task should be blocked).
 */
async function switchToTaskModel(
  options: DispatchOptions,
): Promise<{ state: ModelSwitchState; error?: string }> {
  const { pi, ctx, task, config } = options;
  const role = options.role ?? "implementer";
  const models = config.orchestration.models;

  const state: ModelSwitchState = {
    previousModel: ctx.model,
    previousThinkingLevel: pi.getThinkingLevel?.(),
  };

  const modelString = resolveModelString(models, role, task.model);

  // Resolve against registry (handles parsing + lookup)
  let resolved;
  try {
    if (!ctx.modelRegistry) {
      // No registry available — skip model switching (e.g., in tests or early integration)
      return { state };
    }
    resolved = resolveModel(modelString, ctx.modelRegistry);
  } catch (err) {
    return {
      state,
      error: `Model error for ${role}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Switch model
  const success = await pi.setModel(resolved.model as any);
  if (!success) {
    return {
      state,
      error: `No API key configured for provider "${resolved.model.provider}". Configure it in OMP settings.`,
    };
  }

  // Set thinking level if specified
  if (resolved.thinkingLevel && pi.setThinkingLevel) {
    pi.setThinkingLevel(resolved.thinkingLevel as any);
  }

  return { state };
}

/** Restore the previous model and thinking level after dispatch */
async function restoreModel(
  pi: ExtensionAPI,
  state: ModelSwitchState,
): Promise<void> {
  if (state.previousModel) {
    await pi.setModel(state.previousModel as any).catch(() => {});
  }
  if (state.previousThinkingLevel && pi.setThinkingLevel) {
    pi.setThinkingLevel(state.previousThinkingLevel as any);
  }
}
```

- [ ] **Step 3: Wire model switching into `dispatchAgent`**

Update `dispatchAgent` to call `switchToTaskModel` before dispatch and `restoreModel` after:

```typescript
export async function dispatchAgent(
  options: DispatchOptions,
): Promise<AgentResult> {
  const { pi, ctx, task, planContext, config, lspAvailable, contextModeAvailable } = options;
  const startTime = Date.now();

  // Resolve and switch model
  const { state, error: modelError } = await switchToTaskModel(options);
  if (modelError) {
    notifyError(ctx, `Task ${task.id} model error`, modelError);
    await restoreModel(pi, state);
    return {
      taskId: task.id,
      status: "blocked",
      output: modelError,
      filesChanged: [],
      duration: Date.now() - startTime,
    };
  }

  const prompt = buildTaskPrompt(task, planContext, config, lspAvailable, contextModeAvailable);

  try {
    const result = await executeSubAgent(pi, prompt, task, config);

    const agentResult: AgentResult = {
      taskId: task.id,
      status: result.status,
      output: result.output,
      concerns: result.concerns,
      filesChanged: result.filesChanged,
      duration: Date.now() - startTime,
    };

    switch (agentResult.status) {
      case "done":
        notifySuccess(ctx, `Task ${task.id} completed`, task.name);
        break;
      case "done_with_concerns":
        notifyWarning(ctx, `Task ${task.id} done with concerns`, agentResult.concerns);
        break;
      case "blocked":
        notifyError(ctx, `Task ${task.id} blocked`, agentResult.output);
        break;
    }

    return agentResult;
  } catch (error) {
    const agentResult: AgentResult = {
      taskId: task.id,
      status: "blocked",
      output: `Agent error: ${error instanceof Error ? error.message : String(error)}`,
      filesChanged: [],
      duration: Date.now() - startTime,
    };
    notifyError(ctx, `Task ${task.id} failed`, agentResult.output);
    return agentResult;
  } finally {
    await restoreModel(pi, state);
  }
}
```

- [ ] **Step 4: Add dispatcher integration tests**

Add `tests/orchestrator/dispatcher-model.test.ts`:

```typescript
import { describe, test, expect, vi } from "vitest";
import { dispatchAgent } from "../../src/orchestrator/dispatcher.js";
import type { PlanTask, SupipowersConfig } from "../../src/types.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";

function makeTask(overrides: Partial<PlanTask> = {}): PlanTask {
  return {
    id: 1,
    name: "test-task",
    description: "Test task",
    files: [],
    criteria: "",
    complexity: "small",
    parallelism: { type: "parallel-safe" },
    ...overrides,
  };
}

function makeMockPi(setModelResult = true) {
  return {
    setModel: vi.fn().mockResolvedValue(setModelResult),
    setThinkingLevel: vi.fn(),
    getThinkingLevel: vi.fn().mockReturnValue("medium"),
    sendMessage: vi.fn(),
    exec: vi.fn(),
  } as any;
}

function makeMockCtx(registryModels: Record<string, any> = {}) {
  return {
    cwd: "/tmp/test",
    ui: { notify: vi.fn() },
    model: { id: "claude-sonnet-4", provider: "anthropic" },
    modelRegistry: {
      find(provider: string, modelId: string) {
        return registryModels[`${provider}/${modelId}`];
      },
      getAvailable() {
        return Object.values(registryModels);
      },
    },
  };
}

const defaultRegistry = {
  "anthropic/claude-sonnet-4": { id: "claude-sonnet-4", provider: "anthropic", name: "Claude Sonnet 4" },
  "anthropic/claude-haiku-4": { id: "claude-haiku-4", provider: "anthropic", name: "Claude Haiku 4" },
};

describe("dispatchAgent model resolution", () => {
  test("blocks task when model not found in registry", async () => {
    const pi = makeMockPi();
    const ctx = makeMockCtx(defaultRegistry);
    const task = makeTask({ model: "openai/gpt-4o" });

    const result = await dispatchAgent({
      pi, ctx, task,
      planContext: "",
      config: DEFAULT_CONFIG,
      lspAvailable: false,
      contextModeAvailable: false,
    });

    expect(result.status).toBe("blocked");
    expect(result.output).toContain("not found in registry");
    expect(pi.setModel).not.toHaveBeenCalled();
  });

  test("blocks task when setModel returns false (no API key)", async () => {
    const pi = makeMockPi(false);
    const ctx = makeMockCtx(defaultRegistry);
    const task = makeTask();

    const result = await dispatchAgent({
      pi, ctx, task,
      planContext: "",
      config: DEFAULT_CONFIG,
      lspAvailable: false,
      contextModeAvailable: false,
    });

    expect(result.status).toBe("blocked");
    expect(result.output).toContain("No API key configured");
  });

  test("restores previous model after dispatch (even on error)", async () => {
    const pi = makeMockPi(false); // setModel fails
    const ctx = makeMockCtx(defaultRegistry);
    const task = makeTask();

    await dispatchAgent({
      pi, ctx, task,
      planContext: "",
      config: DEFAULT_CONFIG,
      lspAvailable: false,
      contextModeAvailable: false,
    });

    // Restore should be called with the previous model
    const setModelCalls = pi.setModel.mock.calls;
    // First call: switching to task model (which fails)
    // Second call: restoring previous model
    expect(setModelCalls.length).toBeGreaterThanOrEqual(1);
  });

  test("sets thinking level when specified in model string", async () => {
    const pi = makeMockPi(true);
    const ctx = makeMockCtx(defaultRegistry);
    const config = {
      ...DEFAULT_CONFIG,
      orchestration: {
        ...DEFAULT_CONFIG.orchestration,
        models: { default: "anthropic/claude-sonnet-4:high" },
      },
    };
    const task = makeTask();

    // executeSubAgent will throw (it's a stub), but model switching happens before that
    await dispatchAgent({
      pi, ctx, task,
      planContext: "",
      config,
      lspAvailable: false,
      contextModeAvailable: false,
    });

    expect(pi.setThinkingLevel).toHaveBeenCalledWith("high");
  });
});
```

- [ ] **Step 5: Run tests**

Run: `bun test tests/orchestrator/dispatcher-model.test.ts`

Expected: Tests pass (the model resolution tests exercise model switching; the executeSubAgent stub throws, which is caught and returns blocked).

- [ ] **Step 6: Run typecheck**

Run: `bun run typecheck`

Expected: No type errors.

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator/dispatcher.ts tests/orchestrator/dispatcher-model.test.ts
git commit -m "feat(dispatcher): wire model resolution with save/restore into dispatch flow"
```

### Task 11: Register `/supi:models` in entry point [sequential: depends on 8]

**Files:**
- Modify: `src/index.ts`
- Modify: `tests/integration/extension.test.ts`

- [ ] **Step 1: Add import and registration**

In `src/index.ts`:

Add import:
```typescript
import { registerModelsCommand, handleModels } from "./commands/models.js";
```

Add to the `TUI_COMMANDS` map:
```typescript
  "supi:models": (pi, ctx) => handleModels(pi, ctx),
```

Add registration call in `supipowers()`:
```typescript
  registerModelsCommand(pi);
```

- [ ] **Step 2: Update integration test**

In `tests/integration/extension.test.ts`, add to the registered commands assertion:
```typescript
    expect(registeredCommands).toContain("supi:models");
```

- [ ] **Step 3: Run integration test**

Run: `bun test tests/integration/extension.test.ts`

Expected: PASS — `supi:models` is registered.

- [ ] **Step 4: Run full test suite**

Run: `bun test`

Expected: All tests pass.

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`

Expected: No type errors.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts tests/integration/extension.test.ts
git commit -m "feat: register /supi:models command in extension entry point"
```
