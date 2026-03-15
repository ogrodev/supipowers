# Role-Based Model Configuration Design

**Date:** 2026-03-15
**Status:** Draft
**Scope:** supipowers agent dispatch only — no effect on OMP built-in commands

---

## Problem

The `modelPreference` setting in `supi:config` is inert. It stores one of four abstract labels (`auto`, `fast`, `balanced`, `quality`) but nothing reads it. The dispatcher ignores it, the prompt builder ignores it, and the labels have no defined meaning. Users have no way to control which model handles their sub-agent tasks.

## Goal

Replace the decorative `modelPreference` with a role-based model configuration system that:

1. Maps agent roles (implementer, reviewer, fix-agent) to concrete model IDs.
2. Includes thinking level as a first-class setting per role.
3. Supports per-task overrides via plan annotations.
4. Provides a dedicated `/supi:models` command and a nested menu in `supi:config`.
5. Uses OMP's native model string format and registry APIs.

## Non-Goals

- Configuring models for OMP built-in commands (`/review`, `/plan`, `/commit`). Those use OMP's own role system.
- Validating model IDs at config time. Validation happens at dispatch time against `ctx.modelRegistry.getAvailable()`.
- Shipping model presets or abstract tiers. Users configure concrete model IDs.

---

## Types

### AgentRole

The three roles supipowers dispatches:

```typescript
type AgentRole = 'implementer' | 'reviewer' | 'fixAgent';
```

### ModelConfig

Stored in `SupipowersConfig.orchestration.models`:

```typescript
interface ModelConfig {
  /** Fallback for any role not explicitly set. Format: "provider/model-id" or "provider/model-id:thinking-level" */
  default: string;
  /** Model for implementation sub-agents */
  implementer?: string;
  /** Model for review sub-agents */
  reviewer?: string;
  /** Model for fix/retry sub-agents */
  fixAgent?: string;
}
```

Model strings follow OMP's native format: `"provider/model-id"` with optional thinking suffix `"provider/model-id:thinking-level"`.

Valid thinking levels: `"inherit" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh"`.

### ResolvedModel

The output of resolving a model string against the registry:

```typescript
interface ResolvedModel {
  model: Model;                    // Full OMP Model object from registry
  thinkingLevel?: ThinkingLevel;   // Parsed from ":high" suffix, if present
}
```

### PlanTask Extension

`PlanTask` gains an optional `model` field:

```typescript
// Added to existing PlanTask interface
model?: string;  // Raw model string from [model: ...] annotation
```

### Config Change

`SupipowersConfig.orchestration`:
- **Remove:** `modelPreference: string`
- **Add:** `models: ModelConfig`

---

## Model Resolution

### Precedence Chain

Task annotation > role-specific config > `models.default`.

```typescript
function resolveModelString(
  models: ModelConfig,
  role: AgentRole,
  taskOverride?: string
): string {
  return taskOverride ?? models[role] ?? models.default;
}
```

### Registry Resolution

After resolving the model string, look it up in OMP's model registry:

```typescript
function resolveModel(
  modelString: string,
  registry: ModelRegistry
): ResolvedModel {
  // 1. Parse "provider/model-id:thinking-level"
  //    → { provider, id, thinkingLevel? }
  // 2. Look up via registry.find(provider, id)
  // 3. If not found → throw with available models listed
  // 4. Return { model, thinkingLevel }
}
```

### Dispatcher Integration

The dispatcher performs model switching per task:

1. Save current model (`ctx.model`) and thinking level (`pi.getThinkingLevel()`).
2. Call `resolveModelString(config.orchestration.models, role, task.model)`.
3. Call `resolveModel(modelString, ctx.modelRegistry)` to get the `Model` object.
4. Call `pi.setModel(resolved.model)`. If it returns `false`, the provider lacks credentials — block the task with `"No API key configured for provider '{provider}'. Configure it in OMP settings."` and skip to step 7 (restore).
5. If `resolved.thinkingLevel`, call `pi.setThinkingLevel(resolved.thinkingLevel)`.
6. Dispatch the sub-agent.
7. Restore previous model and thinking level (runs even on failure).

The save-and-restore ensures dispatching a reviewer with haiku doesn't leave the session stuck on haiku.

---

## Plan Task Annotation

Tasks in plan markdown can override the role model:

```markdown
### 3. Refactor auth module [parallel-safe] [model: anthropic/claude-sonnet-4:high]
```

Parsing: one additional regex match on the task header line, same pattern as existing `[parallel-safe]` and `[sequential: depends on N]` annotation parsing. The raw string is stored in `PlanTask.model`; resolution against the registry happens at dispatch time, not parse time. Plans are portable across environments with different available models.

---

## `/supi:models` Command

Dedicated command for model configuration. Registers as:

```typescript
pi.registerCommand('supi:models', {
  description: 'Configure model assignments for supipowers agent roles',
  handler: modelConfigHandler
});
```

### Flow

1. Display current assignments:
   ```
   supipowers Model Configuration
   ────────────────────────────────
   Models for supipowers agent dispatch only.
   OMP commands (/review, /plan, etc.) use their own model settings.

   Default:      anthropic/claude-sonnet-4:high
   Implementer:  (using default)
   Reviewer:     anthropic/claude-haiku-4:off
   Fix Agent:    (using default)
   ```

2. User selects a role to edit.
3. Model selection: models from `ctx.modelRegistry.getAvailable()` grouped by provider, plus "Custom ID" for unlisted models and "Reset to default" for non-default roles.
4. Thinking level selection: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `inherit`.
5. Save to config, confirm the change.

### Shared UI Logic

The model configuration menu is a shared function used by both `/supi:models` (as the full command) and `/supi:config` (as a nested sub-menu entry under "Model Configuration"). No duplication.

---

## Config UI Integration

The existing `supi:config` settings list gains a "Model Configuration" entry. Selecting it delegates to the same shared menu builder that `/supi:models` uses.

---

## Migration

`modelPreference` was never consumed. No behavior changes, clean break:

- `loadConfig()`: if `orchestration.modelPreference` exists and `orchestration.models` doesn't, drop `modelPreference` silently. No mapping from abstract tiers — they were never defined.
- `DEFAULT_CONFIG`: `modelPreference: "auto"` → `models: { default: "anthropic/claude-sonnet-4" }`.
- TypeBox schema: drop `modelPreference`, add `ModelConfig` schema.
- No shims, no backward-compat aliases, no forwarding.

---

## Error Handling

### Model Not Found in Registry

`resolveModel` calls `registry.find(provider, id)`. If not found: emit an error notification listing available models, set the task to `status: 'blocked'` with the reason. The task is aborted but the batch continues — other tasks with valid models proceed.

### Malformed Model String

Parsing fails if format is wrong (no `/` separator, invalid thinking level). Fail at dispatch time: `"Invalid model string 'xyz' for role implementer. Expected format: provider/model-id[:thinking-level]"`. Task gets `status: 'blocked'`.

### Plan Annotation Model Unavailable

Same as "model not found." The plan is portable, dispatch is environment-specific. No retry via fix-agent — wrong model isn't a fixable problem.

### Save-and-Restore Safety

The previous model and thinking level are always restored after dispatch, even on failure. A failed dispatch never leaves the session on a half-switched model.

### Model Set Fails (No API Key)

`pi.setModel()` returns `Promise<boolean>` — `false` when the provider has no API key configured. A model can exist in the registry but lack credentials. If `setModel` returns `false`: block the task with a message naming the provider, restore the previous model, and continue the batch. No retry via fix-agent — missing credentials aren't fixable by an agent.

---

## Files Changed

| File | Change |
|------|--------|
| `src/types.ts` | Add `AgentRole`, `ModelConfig`, `ResolvedModel`. Add `model?: string` to `PlanTask`. Remove `modelPreference` from `SupipowersConfig.orchestration`. Add `models: ModelConfig`. |
| `src/config/schema.ts` | Drop `modelPreference` schema. Add `ModelConfigSchema`. |
| `src/config/defaults.ts` | Replace `modelPreference: "auto"` with `models: { default: "anthropic/claude-sonnet-4" }`. |
| `src/config/loader.ts` | Migration: drop stale `modelPreference` during load. |
| `src/orchestrator/model-resolver.ts` | **New file.** `resolveModelString`, `parseModelString`, `resolveModel`. |
| `src/orchestrator/dispatcher.ts` | Import and use model resolver. Save/restore model+thinking before/after dispatch. |
| `src/commands/models.ts` | **New file.** `/supi:models` command handler. |
| `src/commands/config.ts` | Replace "Model preference" setting with "Model Configuration" nested menu entry. Shared UI builder from `models.ts`. |
| `src/storage/plans.ts` | Parse `[model: ...]` annotation from task headers. |
| `src/index.ts` | Register `supi:models` command. |

---

## Testing

| Module | Tests |
|--------|-------|
| `model-resolver.ts` | `resolveModelString`: all precedence levels (task > role > default). `parseModelString`: valid formats, missing thinking level, malformed strings. `resolveModel`: valid lookup, missing model (error with available list), malformed string. |
| `plans.ts` | `[model: X]` annotation: present, absent, combined with `[parallel-safe]`, combined with `[sequential: ...]`. |
| `dispatcher.ts` | Model resolution called with correct role. Save-and-restore runs on success and failure. Task blocked on invalid model, batch continues. |
| `models.ts` (command) | Summary renders current state. Role selection and model editing flow. |
| `config.ts` (command) | "Model Configuration" entry opens sub-menu. |
| `loader.ts` | Old `modelPreference` configs dropped cleanly. New `models` configs merged correctly across three layers. |
