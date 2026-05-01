/**
 * Authoring agent catalog (parallel namespace to `agent-catalog.ts`).
 *
 * Resolves the spawnable agent prompt body for each authoring slot. Precedence:
 *   1. Project-local override at `.omp/supipowers/ultraplan-authoring-agents/<slot>.md`
 *   2. Global override at `~/.omp/supipowers/ultraplan-authoring-agents/<slot>.md`
 *   3. Built-in default at `src/ultraplan/default-agents/authoring/<slot>.md`
 *
 * Model and thinkingLevel are NOT resolved here — they go through `resolveAuthoringSlotModel`
 * in `model.ts` so the per-stack action ids work uniformly. This module only owns:
 *   - the markdown body (system prompt) the spawned agent receives,
 *   - frontmatter sanity (name + supportedSlots),
 *   - load errors translated to the same `UltraPlanCatalogError` shape as execution slots so
 *     the picker / status renderer can show a unified error list.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import intakeAsset from "../default-agents/authoring/intake.md" with { type: "text" };
import scoutAsset from "../default-agents/authoring/scout.md" with { type: "text" };
import discovererAsset from "../default-agents/authoring/discoverer.md" with { type: "text" };
import researcherAsset from "../default-agents/authoring/researcher.md" with { type: "text" };
import plannerAsset from "../default-agents/authoring/planner.md" with { type: "text" };
import structureCheckerAsset from "../default-agents/authoring/structure-checker.md" with { type: "text" };
import scopeCheckerAsset from "../default-agents/authoring/scope-checker.md" with { type: "text" };
import tddCheckerAsset from "../default-agents/authoring/tdd-checker.md" with { type: "text" };

import { MarkdownFrontmatterError, parseMarkdownFrontmatter } from "../../markdown-frontmatter.js";
import type { PlatformPaths } from "../../platform/types.js";
import type {
  UltraPlanAuthoringSlotName,
  UltraPlanCatalogError,
} from "../../types.js";
import { ULTRAPLAN_AUTHORING_SLOT_NAMES } from "../contracts.js";

// ---------------------------------------------------------------------------
// Constants and types
// ---------------------------------------------------------------------------

/** Subdirectory used for project- and global-scoped authoring overrides. */
export const ULTRAPLAN_AUTHORING_AGENTS_DIRNAME = "ultraplan-authoring-agents";

export type UltraPlanAuthoringDefinitionSource = "built-in" | "global" | "project";

export interface UltraPlanAuthoringAgentDefinition {
  slot: UltraPlanAuthoringSlotName;
  name: string;
  description: string;
  supportedSlots: UltraPlanAuthoringSlotName[];
  focus: string | null;
  prompt: string;
  filePath: string;
  source: UltraPlanAuthoringDefinitionSource;
}

export interface ResolvedUltraPlanAuthoringSlotBinding {
  slot: UltraPlanAuthoringSlotName;
  definition: UltraPlanAuthoringAgentDefinition;
}

export interface ResolvedUltraPlanAuthoringCatalog {
  slots: Record<UltraPlanAuthoringSlotName, ResolvedUltraPlanAuthoringSlotBinding>;
}

export interface UltraPlanAuthoringCatalogLoadResult {
  ok: boolean;
  value: ResolvedUltraPlanAuthoringCatalog;
  errors: UltraPlanCatalogError[];
}

// ---------------------------------------------------------------------------
// Built-in asset table (one entry per slot)
// ---------------------------------------------------------------------------

const BUILT_IN_AUTHORING_ASSETS: Record<
  UltraPlanAuthoringSlotName,
  { content: string; filePath: string }
> = {
  "intake": {
    content: intakeAsset,
    filePath: fileURLToPath(new URL("../default-agents/authoring/intake.md", import.meta.url)),
  },
  "scout": {
    content: scoutAsset,
    filePath: fileURLToPath(new URL("../default-agents/authoring/scout.md", import.meta.url)),
  },
  "discoverer": {
    content: discovererAsset,
    filePath: fileURLToPath(new URL("../default-agents/authoring/discoverer.md", import.meta.url)),
  },
  "researcher": {
    content: researcherAsset,
    filePath: fileURLToPath(new URL("../default-agents/authoring/researcher.md", import.meta.url)),
  },
  "planner": {
    content: plannerAsset,
    filePath: fileURLToPath(new URL("../default-agents/authoring/planner.md", import.meta.url)),
  },
  "structure-checker": {
    content: structureCheckerAsset,
    filePath: fileURLToPath(new URL("../default-agents/authoring/structure-checker.md", import.meta.url)),
  },
  "scope-checker": {
    content: scopeCheckerAsset,
    filePath: fileURLToPath(new URL("../default-agents/authoring/scope-checker.md", import.meta.url)),
  },
  "tdd-checker": {
    content: tddCheckerAsset,
    filePath: fileURLToPath(new URL("../default-agents/authoring/tdd-checker.md", import.meta.url)),
  },
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const KNOWN_SLOTS = new Set<UltraPlanAuthoringSlotName>(ULTRAPLAN_AUTHORING_SLOT_NAMES);

function makeError(
  slot: UltraPlanAuthoringSlotName | null,
  code: UltraPlanCatalogError["code"],
  message: string,
  filePath: string | null = null,
): UltraPlanCatalogError {
  // The unified UltraPlanCatalogError carries an execution-slot name in `slot`. Authoring
  // slots are not part of that enum, so we annotate the message with the authoring slot
  // name and leave the field null. The picker/status renderer renders messages verbatim.
  const annotated = slot ? `[authoring/${slot}] ${message}` : message;
  return { slot: null, code, message: annotated, path: filePath };
}

function parseAuthoringMarkdown(
  content: string,
  filePath: string,
  source: UltraPlanAuthoringDefinitionSource,
): UltraPlanAuthoringAgentDefinition {
  const { frontmatter, body } = parseMarkdownFrontmatter(content, filePath);
  const fm = frontmatter as Partial<{
    name: unknown;
    description: unknown;
    supportedSlots: unknown;
    focus: unknown;
  }>;

  if (typeof fm.name !== "string" || fm.name.length === 0) {
    throw new MarkdownFrontmatterError("invalid-frontmatter", filePath, "Authoring agent frontmatter requires `name`.");
  }
  if (typeof fm.description !== "string" || fm.description.length === 0) {
    throw new MarkdownFrontmatterError("invalid-frontmatter", filePath, "Authoring agent frontmatter requires `description`.");
  }
  if (!Array.isArray(fm.supportedSlots) || fm.supportedSlots.length === 0) {
    throw new MarkdownFrontmatterError("invalid-frontmatter", filePath, "Authoring agent frontmatter requires non-empty `supportedSlots` list.");
  }

  const slots: UltraPlanAuthoringSlotName[] = [];
  for (const raw of fm.supportedSlots as unknown[]) {
    if (typeof raw !== "string" || !KNOWN_SLOTS.has(raw as UltraPlanAuthoringSlotName)) {
      throw new MarkdownFrontmatterError("invalid-frontmatter", filePath, `Authoring agent frontmatter references unknown slot ${JSON.stringify(raw)}.`);
    }
    slots.push(raw as UltraPlanAuthoringSlotName);
  }

  // For built-in slot definitions, `name` must equal the slot. For overrides we allow any
  // name as long as the slot is present in `supportedSlots` — this mirrors the behavior of
  // the execution catalog for global agents.
  const slot = slots[0]!;

  return {
    slot,
    name: fm.name,
    description: fm.description,
    supportedSlots: slots,
    focus: typeof fm.focus === "string" && fm.focus.length > 0 ? fm.focus : null,
    prompt: body,
    filePath,
    source,
  };
}

function loadBuiltInDefinitions(): Map<UltraPlanAuthoringSlotName, UltraPlanAuthoringAgentDefinition> {
  const bySlot = new Map<UltraPlanAuthoringSlotName, UltraPlanAuthoringAgentDefinition>();
  for (const slot of ULTRAPLAN_AUTHORING_SLOT_NAMES) {
    const asset = BUILT_IN_AUTHORING_ASSETS[slot];
    const definition = parseAuthoringMarkdown(asset.content, asset.filePath, "built-in");

    // Guard rail: built-in `name` MUST equal the slot. This prevents silent typos in the
    // markdown frontmatter from changing slot resolution. Tests assert this.
    if (definition.name !== slot) {
      throw new MarkdownFrontmatterError("invalid-frontmatter", asset.filePath, `Built-in authoring agent ${asset.filePath} must use name "${slot}" (got ${JSON.stringify(definition.name)}).`);
    }
    if (definition.supportedSlots.length !== 1 || definition.supportedSlots[0] !== slot) {
      throw new MarkdownFrontmatterError("invalid-frontmatter", asset.filePath, `Built-in authoring agent ${asset.filePath} must support exactly slot "${slot}".`);
    }

    bySlot.set(slot, definition);
  }
  return bySlot;
}

let cachedBuiltIn: Map<UltraPlanAuthoringSlotName, UltraPlanAuthoringAgentDefinition> | null = null;
function getBuiltInDefinitions(): Map<UltraPlanAuthoringSlotName, UltraPlanAuthoringAgentDefinition> {
  cachedBuiltIn ??= loadBuiltInDefinitions();
  return cachedBuiltIn;
}

function loadOverrideDefinition(
  filePath: string,
  source: UltraPlanAuthoringDefinitionSource,
): { definition: UltraPlanAuthoringAgentDefinition | null; error: UltraPlanCatalogError | null } {
  if (!fs.existsSync(filePath)) {
    return { definition: null, error: null };
  }
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const definition = parseAuthoringMarkdown(raw, filePath, source);
    return { definition, error: null };
  } catch (error) {
    if (error instanceof MarkdownFrontmatterError) {
      return {
        definition: null,
        error: makeError(null, "invalid-agent-definition", error.message, error.filePath ?? filePath),
      };
    }
    const message = error instanceof Error ? error.message : `Unable to read ${filePath}`;
    return {
      definition: null,
      error: makeError(null, "catalog-io", message, filePath),
    };
  }
}

function resolveOverrideForSlot(
  slot: UltraPlanAuthoringSlotName,
  paths: PlatformPaths,
  cwd: string,
): { definition: UltraPlanAuthoringAgentDefinition | null; error: UltraPlanCatalogError | null } {
  // 1. Project-local: .omp/supipowers/ultraplan-authoring-agents/<slot>.md
  const projectPath = paths.project(cwd, ULTRAPLAN_AUTHORING_AGENTS_DIRNAME, `${slot}.md`);
  const projectResult = loadOverrideDefinition(projectPath, "project");
  if (projectResult.error) return projectResult;
  if (projectResult.definition) return projectResult;

  // 2. Global: ~/.omp/supipowers/ultraplan-authoring-agents/<slot>.md
  const globalPath = paths.global(ULTRAPLAN_AUTHORING_AGENTS_DIRNAME, `${slot}.md`);
  const globalResult = loadOverrideDefinition(globalPath, "global");
  return globalResult;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve every authoring slot to a concrete agent definition. Errors that prevent at least
 * one slot from resolving are returned in `errors`; the catalog still surfaces the built-in
 * fallback for those slots so the rest of the pipeline can report a structured blocker.
 */
export function loadUltraPlanAuthoringCatalog(
  paths: PlatformPaths,
  cwd: string,
): UltraPlanAuthoringCatalogLoadResult {
  const builtIns = getBuiltInDefinitions();
  const slots: Partial<Record<UltraPlanAuthoringSlotName, ResolvedUltraPlanAuthoringSlotBinding>> = {};
  const errors: UltraPlanCatalogError[] = [];

  for (const slot of ULTRAPLAN_AUTHORING_SLOT_NAMES) {
    const builtIn = builtIns.get(slot);
    if (!builtIn) {
      // Should be impossible — the built-in table is exhaustive at module load.
      errors.push(
        makeError(slot, "missing-built-in-definition", `No built-in definition registered for authoring slot ${slot}`, null),
      );
      continue;
    }

    const overrideResult = resolveOverrideForSlot(slot, paths, cwd);
    if (overrideResult.error) {
      errors.push(overrideResult.error);
      // Fall back to the built-in so other slots still resolve.
      slots[slot] = { slot, definition: builtIn };
      continue;
    }

    const chosen = overrideResult.definition ?? builtIn;
    slots[slot] = { slot, definition: chosen };
  }

  const ok = errors.length === 0 && ULTRAPLAN_AUTHORING_SLOT_NAMES.every((s) => slots[s] !== undefined);
  return {
    ok,
    value: { slots: slots as ResolvedUltraPlanAuthoringCatalog["slots"] },
    errors,
  };
}

/** Convenience: fetch a single slot binding without resolving the whole catalog. */
export function resolveAuthoringSlot(
  slot: UltraPlanAuthoringSlotName,
  paths: PlatformPaths,
  cwd: string,
): ResolvedUltraPlanAuthoringSlotBinding {
  const catalog = loadUltraPlanAuthoringCatalog(paths, cwd);
  const binding = catalog.value.slots[slot];
  if (!binding) {
    throw new Error(`Authoring slot ${slot} did not resolve (errors: ${catalog.errors.map((e) => e.message).join("; ")})`);
  }
  return binding;
}
