import type { ModelConfig, ResolvedModel } from "../types.js";
import type { ModelActionRegistry } from "./model-registry.js";

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

  // Tier 4: Main session model
  return {
    model: platform.getCurrentModel(),
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

  // Tier 4 (always present)
  candidates.push({ model: platform.getCurrentModel(), thinkingLevel: null, source: "main" });

  // Deduplicate by model (keep first occurrence = highest priority)
  const seen = new Set<string>();
  return candidates.filter((c) => {
    if (seen.has(c.model)) return false;
    seen.add(c.model);
    return true;
  });
}
