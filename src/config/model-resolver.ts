import type { ModelConfig, ResolvedModel } from "../types.js";
import type { ModelActionRegistry } from "./model-registry.js";
import type { Platform } from "../platform/types.js";

export interface ModelPlatformBridge {
  getModelForRole(role: string): string | null;
  getCurrentModel(): string;
}

export function resolveModelForAction(
  actionId: string,
  registry: ModelActionRegistry,
  config: ModelConfig,
  platform: ModelPlatformBridge,
): ResolvedModel {
  // Tier 1: Per-action config
  const actionConfig = config.actions[actionId];
  if (actionConfig) {
    return {
      model: actionConfig.model,
      thinkingLevel: actionConfig.thinkingLevel,
      source: "action",
    };
  }

  // Tier 2: Supipowers default
  if (config.default) {
    return {
      model: config.default.model,
      thinkingLevel: config.default.thinkingLevel,
      source: "default",
    };
  }

  // Tier 3: Harness role match
  const action = registry.get(actionId);
  const roleHint = action?.harnessRoleHint ?? "default";
  const roleModel = platform.getModelForRole(roleHint);
  if (roleModel) {
    return {
      model: roleModel,
      thinkingLevel: null,
      source: "harness-role",
    };
  }

  // Tier 4: Main session model (may be undefined if harness doesn't report one)
  const mainModel = platform.getCurrentModel();
  const validMain = mainModel && mainModel !== "unknown" ? mainModel : undefined;
  return {
    model: validMain,
    thinkingLevel: null,
    source: "main",
  };
}

/**
 * Return the full fallback chain for an action, ordered by priority.
 * Callers iterate this list and stop at the first model that works.
 * Used for auto-retry when a model is unavailable.
 */
export function resolveAllCandidates(
  actionId: string,
  registry: ModelActionRegistry,
  config: ModelConfig,
  platform: ModelPlatformBridge,
): ResolvedModel[] {
  const candidates: ResolvedModel[] = [];

  // Tier 1
  const actionConfig = config.actions[actionId];
  if (actionConfig) {
    candidates.push({ model: actionConfig.model, thinkingLevel: actionConfig.thinkingLevel, source: "action" });
  }

  // Tier 2
  if (config.default) {
    candidates.push({ model: config.default.model, thinkingLevel: config.default.thinkingLevel, source: "default" });
  }

  // Tier 3
  const action = registry.get(actionId);
  const roleHint = action?.harnessRoleHint ?? "default";
  const roleModel = platform.getModelForRole(roleHint);
  if (roleModel) {
    candidates.push({ model: roleModel, thinkingLevel: null, source: "harness-role" });
  }

  // Tier 4: Main session model (skip if harness doesn't report a valid one)
  const mainModel = platform.getCurrentModel();
  if (mainModel && mainModel !== "unknown") {
    candidates.push({ model: mainModel, thinkingLevel: null, source: "main" });
  }

  // Deduplicate by model (keep first occurrence = highest priority)
  const seen = new Set<string>();
  return candidates.filter((c) => {
    if (!c.model || seen.has(c.model)) return false;
    seen.add(c.model);
    return true;
  });
}

export function createModelBridge(platform: Platform): ModelPlatformBridge {
  return {
    getModelForRole(role: string): string | null {
      return platform.getModelForRole?.(role) ?? null;
    },
    getCurrentModel(): string {
      return platform.getCurrentModel?.() ?? "unknown";
    },
  };
}

/**
 * Apply a resolved model override to the current session.
 *
 * Resolves the string model ID to an OMP Model object via the context's
 * modelRegistry, then calls platform.setModel() with it. Also applies
 * thinking level if specified.
 *
 * @param platform - The platform adapter
 * @param ctx - Command handler context (must have modelRegistry.getAvailable())
 * @param actionId - The action being configured (e.g. "plan", "review") — used in notification
 * @param resolved - The resolved model from resolveModelForAction()
 * @returns cleanup function — call in `finally` to clear the status bar and restore the
 *   original model. Safe to call multiple times (idempotent). Returns a no-op if nothing
 *   was applied.
 */
export async function applyModelOverride(
  platform: Platform,
  ctx: any,
  actionId: string,
  resolved: ResolvedModel,
): Promise<() => Promise<void>> {
  // Skip if resolution fell through to the main session model (nothing to change)
  if (resolved.source === "main") return async () => {};

  const modelId = resolved.model;
  if (!modelId) return async () => {};

  // Apply thinking level (independent of model switch success)
  if (resolved.thinkingLevel && platform.setThinkingLevel) {
    platform.setThinkingLevel(resolved.thinkingLevel);
  }

  if (!platform.setModel) return async () => {};

  // Resolve string model ID to full OMP Model object via the context's model registry.
  // OMP's setModel expects a Model object (with provider, id, api, etc.), not a string.
  const available = ctx.modelRegistry?.getAvailable?.() as any[] | undefined;
  if (!available) return async () => {};

  const modelObj = available.find((m: any) => {
    if (!m?.id) return false;
    if (modelId === m.id) return true;
    if (modelId === `${m.provider}/${m.id}`) return true;
    return modelId.includes("/") ? false : m.id === modelId;
  });

  if (!modelObj) return async () => {};

  // Save current model so we can restore after the agent turn completes.
  // OMP's extension API setModel() persists to settings (calls session.setModel,
  // not session.setModelTemporary). We must restore to avoid permanently
  // overriding the user's default model.
  const originalModel = ctx.model;

  const applied = await platform.setModel(modelObj);
  if (!applied) return async () => {};

  // Show persistent model override info in the footer status bar.
  // ctx.ui.notify() is transient and gets immediately replaced by progress widgets;
  // setStatus persists alongside them.
  const STATUS_KEY = "supi-model";
  const displayName = modelObj.name ?? modelObj.id ?? modelId;
  const sourceLabel =
    resolved.source === "action" ? `configured for ${actionId}` :
    resolved.source === "default" ? "supipowers default" :
    "harness role";
  let detail = sourceLabel;
  if (resolved.thinkingLevel) {
    detail += ` \u00b7 ${resolved.thinkingLevel} thinking`;
  }
  ctx.ui?.setStatus?.(STATUS_KEY, `Model: ${displayName} (${detail})`);

  // Cleanup: clear the status bar entry and restore the original model.
  // Idempotent — safe to call multiple times.
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    ctx.ui?.setStatus?.(STATUS_KEY, undefined);
    if (originalModel) {
      await platform.setModel!(originalModel);
    }
  };

  // Safety net for agent-driven commands: if the caller hands off to an OMP agent
  // session and never calls cleanup explicitly, agent_end will still clear the status.
  platform.on("agent_end", cleanup);

  return cleanup;
}
