/**
 * Per-action-id model resolution for the multi-stage authoring pipeline.
 *
 * The pipeline runs every stage in a fresh `platform.createAgentSession`. Each spawned session
 * needs a model identifier and (optionally) a thinking level. Selection follows the standard
 * supipowers four-tier resolution implemented by `resolveModelForAction`:
 *   1. `model.json` per-action override (`actions["ultraplan.authoring.<slot>"]`)
 *   2. `model.json#default` (the workspace-wide supipowers default)
 *   3. The platform's harness role hint (architect / research / review / default)
 *   4. The main session model
 *
 * Stack-parameterized researchers each get their own action id (`...researcher.frontend`,
 * `...researcher.backend`, `...researcher.infrastructure`), so per-stack overrides are a flat
 * lookup in `model.json`. We register every action id at module load so the resolver and any
 * tooling that introspects the registry sees them on first import.
 */

import type {
  ModelConfig,
  ResolvedModel,
  UltraPlanAuthoringSlotName,
  UltraPlanStackId,
} from "../../types.js";
import {
  resolveModelForAction,
  type ModelPlatformBridge,
} from "../../config/model-resolver.js";
import type { ModelActionRegistry } from "../../config/model-registry.js";
import { modelRegistry } from "../../config/model-registry-instance.js";
import { ULTRAPLAN_STACKS } from "../contracts.js";

/** Action-id namespace for the authoring pipeline. Centralized so callers do not inline. */
export const ULTRAPLAN_AUTHORING_ACTION_NAMESPACE = "ultraplan.authoring";

/**
 * Returns the action id for an authoring slot, optionally parameterised by stack for the
 * researcher slot.
 *
 * - For non-researcher slots, the stack hint is ignored.
 * - For the researcher slot with no stack hint, the unparameterised id is returned (used by
 *   tooling that needs to address "the family of researcher actions" in the abstract). At
 *   resolution time, callers should always pass a stack hint.
 */
export function getAuthoringActionId(
  slot: UltraPlanAuthoringSlotName,
  stackHint: UltraPlanStackId | null = null,
): string {
  if (slot === "researcher" && stackHint !== null) {
    return `${ULTRAPLAN_AUTHORING_ACTION_NAMESPACE}.researcher.${stackHint}`;
  }
  return `${ULTRAPLAN_AUTHORING_ACTION_NAMESPACE}.${slot}`;
}

/**
 * Resolve the model and thinking level for an authoring slot. Mirrors `resolveModelForAction`
 * exactly — this is a thin wrapper that builds the correct action id and delegates so the
 * four-tier fallback semantics stay identical to every other resolver call site.
 *
 * Use this in stage runners just before `createAgentSession`:
 *
 *   const { model, thinkingLevel } = resolveAuthoringSlotModel(
 *     "researcher", "backend", config, modelRegistry, platformBridge,
 *   );
 *   const session = platform.createAgentSession({ ..., model, thinkingLevel });
 */
export function resolveAuthoringSlotModel(
  slot: UltraPlanAuthoringSlotName,
  stackHint: UltraPlanStackId | null,
  config: ModelConfig,
  registry: ModelActionRegistry,
  platform: ModelPlatformBridge,
): ResolvedModel {
  const actionId = getAuthoringActionId(slot, stackHint);
  return resolveModelForAction(actionId, registry, config, platform);
}

// ---------------------------------------------------------------------------
// Action registration. Runs at module load — every `import "..."` of this file ensures the
// authoring action ids are visible to the registry. Cheap to do up-front because each slot
// is registered exactly once (the registry is idempotent for repeated `register` calls with
// the same id; see `model-registry.ts`).
//
// Harness role hints map authoring slots to the four canonical harness roles (architect,
// research, review, default) so users on a stock harness get sensible models without ever
// editing model.json. Per-stack researchers all share the `research` role hint.
// ---------------------------------------------------------------------------

interface AuthoringActionRegistration {
  id: string;
  label: string;
  harnessRoleHint: string;
}

function buildAuthoringActionRegistrations(): AuthoringActionRegistration[] {
  const fixed: AuthoringActionRegistration[] = [
    {
      id: getAuthoringActionId("intake"),
      label: "UltraPlan authoring · intake",
      harnessRoleHint: "architect",
    },
    {
      id: getAuthoringActionId("scout"),
      label: "UltraPlan authoring · scout",
      harnessRoleHint: "research",
    },
    {
      id: getAuthoringActionId("discoverer"),
      label: "UltraPlan authoring · discover",
      harnessRoleHint: "architect",
    },
    {
      id: getAuthoringActionId("planner"),
      label: "UltraPlan authoring · planner",
      harnessRoleHint: "architect",
    },
    {
      id: getAuthoringActionId("structure-checker"),
      label: "UltraPlan authoring · structure checker",
      harnessRoleHint: "review",
    },
    {
      id: getAuthoringActionId("scope-checker"),
      label: "UltraPlan authoring · scope checker",
      harnessRoleHint: "review",
    },
    {
      id: getAuthoringActionId("tdd-checker"),
      label: "UltraPlan authoring · TDD checker",
      harnessRoleHint: "review",
    },
  ];

  const researchers: AuthoringActionRegistration[] = ULTRAPLAN_STACKS.map((stack) => ({
    id: getAuthoringActionId("researcher", stack),
    label: `UltraPlan authoring · researcher (${stack})`,
    harnessRoleHint: "research",
  }));

  return [...fixed, ...researchers];
}

/**
 * Registry of every authoring action id, exposed for tooling and tests. The order is stable
 * (fixed slots first, then researchers in `ULTRAPLAN_STACKS` order) so snapshot tests can
 * match without sorting.
 */
export const AUTHORING_ACTION_REGISTRATIONS: readonly AuthoringActionRegistration[] = Object.freeze(
  buildAuthoringActionRegistrations(),
);

// Register them once at module load. Node's module cache guarantees this file's body runs at
// most once per process, so the registry never sees duplicate calls (the registry rejects
// duplicate ids by design).
for (const action of AUTHORING_ACTION_REGISTRATIONS) {
  modelRegistry.register({
    id: action.id,
    category: "sub-agent",
    parent: "ultraplan",
    label: action.label,
    harnessRoleHint: action.harnessRoleHint,
  });
}
