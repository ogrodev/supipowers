/**
 * Per-action-id model resolution for the harness pipeline.
 *
 * Mirrors `src/ultraplan/authoring/model.ts`:
 *  1. `model.json` per-action override (`actions["harness.<stage>"]`)
 *  2. `model.json#default`
 *  3. Platform's harness role hint
 *  4. Main session model
 *
 * Action ids are flat strings; researchers fan out per-topic with composable suffixes
 * (`harness.research.<topicSlug>`) so per-topic overrides are a single lookup.
 *
 * The module body registers every fixed action id at load time. Topic-parameterized
 * researcher ids are registered lazily when the researcher launches each topic — Discover
 * may produce dozens of topics across runs and we prefer to register what we actually
 * resolve rather than every theoretically reachable topic.
 */

import { resolveModelForAction, type ModelPlatformBridge } from "../config/model-resolver.js";
import { modelRegistry } from "../config/model-registry-instance.js";
import type { ModelActionRegistry } from "../config/model-registry.js";
import type { ModelConfig, ResolvedModel } from "../types.js";

/** Action-id namespace. Centralized so call sites never inline the literal. */
export const HARNESS_ACTION_NAMESPACE = "harness";

/** Fixed (non-parameterized) action ids. */
export type HarnessFixedActionSlot =
  | "discover"
  | "design"
  | "plan"
  | "implement"
  | "validate"
  | "gc.fix"
  | "review.architecture";

interface HarnessActionRegistration {
  id: string;
  label: string;
  harnessRoleHint: string;
}

const FIXED_REGISTRATIONS: readonly HarnessActionRegistration[] = Object.freeze([
  { id: `${HARNESS_ACTION_NAMESPACE}.discover`, label: "Harness · discover", harnessRoleHint: "research" },
  { id: `${HARNESS_ACTION_NAMESPACE}.design`, label: "Harness · design", harnessRoleHint: "plan" },
  { id: `${HARNESS_ACTION_NAMESPACE}.plan`, label: "Harness · plan", harnessRoleHint: "plan" },
  { id: `${HARNESS_ACTION_NAMESPACE}.implement`, label: "Harness · implement", harnessRoleHint: "default" },
  { id: `${HARNESS_ACTION_NAMESPACE}.validate`, label: "Harness · validate", harnessRoleHint: "review" },
  { id: `${HARNESS_ACTION_NAMESPACE}.gc.fix`, label: "Harness · GC fix", harnessRoleHint: "default" },
  { id: `${HARNESS_ACTION_NAMESPACE}.review.architecture`, label: "Harness · architecture review", harnessRoleHint: "review" },
]);

/** Action ids exposed for tooling and tests (frozen at module load). */
export const HARNESS_FIXED_ACTION_IDS: readonly string[] = Object.freeze(
  FIXED_REGISTRATIONS.map((r) => r.id),
);

/** Returns the canonical action id for a fixed slot. */
export function getHarnessActionId(slot: HarnessFixedActionSlot): string {
  return `${HARNESS_ACTION_NAMESPACE}.${slot}`;
}

/** Returns the action id for a research topic. Topic slug is sanitized by the caller. */
export function getHarnessResearchActionId(topicSlug: string): string {
  return `${HARNESS_ACTION_NAMESPACE}.research.${topicSlug}`;
}

/** Resolve the model + thinking level for a fixed harness action slot. */
export function resolveHarnessModel(
  slot: HarnessFixedActionSlot,
  config: ModelConfig,
  registry: ModelActionRegistry,
  platform: ModelPlatformBridge,
): ResolvedModel {
  return resolveModelForAction(getHarnessActionId(slot), registry, config, platform);
}

/** Resolve the model + thinking level for a research topic action. Registers lazily. */
export function resolveHarnessResearchModel(
  topicSlug: string,
  config: ModelConfig,
  registry: ModelActionRegistry,
  platform: ModelPlatformBridge,
): ResolvedModel {
  const id = getHarnessResearchActionId(topicSlug);
  // Registration is idempotent at our boundary — the registry rejects duplicate ids by
  // design, so we wrap in try/catch to keep lazy registration safe across multiple calls
  // in the same process.
  try {
    registry.register({
      id,
      category: "sub-agent",
      parent: "harness",
      label: `Harness · research (${topicSlug})`,
      harnessRoleHint: "research",
    });
  } catch {
    // Already registered — fine.
  }
  return resolveModelForAction(id, registry, config, platform);
}

// ---------------------------------------------------------------------------
// Module-load registration. Mirrors the ultraplan/authoring/model.ts pattern: every
// `import "../model.js"` of this file ensures the harness action ids are visible to the
// shared registry. Cheap and idempotent.
// ---------------------------------------------------------------------------

for (const action of FIXED_REGISTRATIONS) {
  modelRegistry.register({
    id: action.id,
    category: "sub-agent",
    parent: "harness",
    label: action.label,
    harnessRoleHint: action.harnessRoleHint,
  });
}
