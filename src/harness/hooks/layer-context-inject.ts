/**
 * Layer-context-injection hook.
 *
 * Registered on `before_agent_start`. Reads `docs/architecture.md`, determines the layer
 * of the file the agent is about to edit, and prepends a system-prompt addendum so the
 * agent is reminded of the import rules.
 *
 * Degrades gracefully:
 *  - missing `docs/architecture.md` → no addendum,
 *  - no rule matches the file → no addendum,
 *  - addendum exceeds `addendum_max_chars` → truncated with "…".
 *
 * The hook does NOT block tool calls; it only augments the system prompt. We never
 * extract the "file the agent is about to edit" from the system-prompt event itself —
 * that would require parsing user prompts. Instead, callers wire the hook with a
 * `file-resolver` that pulls the candidate file from the active session metadata, and
 * fall back to no-op when no candidate exists.
 */

import * as fs from "node:fs";

import type { Platform } from "../../platform/types.js";
import { prependSystemPromptBlock } from "../../platform/system-prompt.js";
import type { HarnessHookConfig, HarnessLayerRule } from "../../types.js";
import {
  buildLayerAddendum,
  parseArchitectureMarkdown,
  resolveLayerForFile,
} from "../anti_slop/architecture-parser.js";
import {
  getHarnessArchitectureDocPath,
  getHarnessMarkerPath,
} from "../project-paths.js";
import { extractAgentContextSection } from "../docs/validator.js";
import { parseProvenance } from "../docs/provenance.js";

export interface LayerContextHookOptions {
  /**
   * Resolves a candidate file path from the event/ctx pair. Implementations consult
   * session metadata, the user's last prompt, or recent tool calls — whatever the
   * harness can wire through. Returning `null` short-circuits the hook.
   */
  resolveCandidateFile: (event: unknown, ctx: unknown) => string | null;
  /** Hook config snapshot. Defaults to disabled when undefined. */
  config?: HarnessHookConfig["layer_context_inject"];
}

const DEFAULT_CONFIG: HarnessHookConfig["layer_context_inject"] = {
  enabled: false,
  addendum_max_chars: 800,
};

interface CachedRules {
  layerRules: HarnessLayerRule[];
  mtimeMs: number;
}

/** Cache the parsed rules per architecture-doc path so we don't re-read on every hook. */
const rulesCache = new Map<string, CachedRules>();

function loadRules(archPath: string): HarnessLayerRule[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(archPath);
  } catch {
    return [];
  }
  const cached = rulesCache.get(archPath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.layerRules;
  let md: string;
  try {
    md = fs.readFileSync(archPath, "utf8");
  } catch {
    return [];
  }
  const layerRules = parseArchitectureMarkdown(md);
  rulesCache.set(archPath, { layerRules, mtimeMs: stat.mtimeMs });
  return layerRules;
}

export interface LayerContextInjectionResult {
  /** Addendum to prepend to the system prompt; empty string when no-op. */
  addendum: string;
  /** Why the hook returned what it did — used by tests. */
  reason: string;
}

/**
 * Compute the addendum for a single hook invocation. Pure-ish: reads the file system but
 * never mutates state. Tests call this directly with a known cwd + candidate file.
 *
 * Resolution order:
 *   1. If `docs/layers/<layerId>.md` exists, extract its `## Agent context` section and
 *      return it (capped at `addendum_max_chars`). This is the preferred path once the
 *      docs stage has run.
 *   2. Otherwise, fall back to the architecture-doc-derived addendum so projects that
 *      have not generated per-layer docs still receive a useful reminder.
 */
export function computeLayerAddendum(input: {
  cwd: string;
  candidateFile: string | null;
  config: HarnessHookConfig["layer_context_inject"];
  /** Override the resolved architecture-doc path; tests use this to point at a fixture. */
  archPath?: string;
  /** Override the resolved per-layer doc path; tests use this to point at a fixture. */
  layerDocPath?: (layerId: string) => string;
}): LayerContextInjectionResult {
  if (!input.config.enabled) return { addendum: "", reason: "disabled" };
  if (!input.candidateFile) return { addendum: "", reason: "no candidate file" };
  const archPath = input.archPath ?? `${input.cwd}/docs/architecture.md`;
  const rules = loadRules(archPath);
  if (rules.length === 0) return { addendum: "", reason: "no rules parsed" };
  const rule = resolveLayerForFile(input.candidateFile, rules);
  if (!rule) return { addendum: "", reason: "no rule matches candidate file" };

  // Preferred path: per-layer agent doc.
  const docPath = input.layerDocPath
    ? input.layerDocPath(rule.layer)
    : `${input.cwd}/docs/layers/${rule.layer}.md`;
  if (fs.existsSync(docPath)) {
    try {
      const contents = fs.readFileSync(docPath, "utf8");
      const parsed = parseProvenance(contents);
      const body = parsed ? parsed.body : contents;
      const section = extractAgentContextSection(body);
      if (section.length > 0) {
        const cap = input.config.addendum_max_chars;
        const capped = section.length <= cap
          ? section
          : `${section.slice(0, Math.max(0, cap - 1))}…`;
        return { addendum: capped, reason: "matched (per-layer doc)" };
      }
    } catch {
      // fall through to architecture-doc fallback on any read error
    }
  }

  const addendum = buildLayerAddendum(input.candidateFile, rule, input.config.addendum_max_chars);
  return { addendum, reason: "matched (architecture.md fallback)" };
}

/**
 * Register the hook. Returns a teardown function the caller can invoke to revoke
 * registration (used by tests). The hook is gated by the harness marker — when the
 * marker is missing, the hook is a no-op (it never reads the architecture doc).
 */
export function registerLayerContextInjectHook(
  platform: Platform,
  options: LayerContextHookOptions,
): () => void {
  const config = options.config ?? DEFAULT_CONFIG;
  if (!config.enabled) {
    return () => {};
  }

  let unregistered = false;
  const handler = (event: unknown, ctx: unknown): { systemPrompt: string[] } | undefined => {
    if (unregistered) return undefined;
    const cwd = (ctx as { cwd?: string } | undefined)?.cwd ?? process.cwd();
    if (!fs.existsSync(getHarnessMarkerPath(platform.paths, cwd))) return undefined;

    const candidateFile = options.resolveCandidateFile(event, ctx);
    const result = computeLayerAddendum({
      cwd,
      candidateFile,
      config,
      archPath: getHarnessArchitectureDocPath(platform.paths, cwd),
    });
    if (result.addendum.length === 0) return undefined;

    return {
      systemPrompt: prependSystemPromptBlock(
        (event as { systemPrompt?: unknown } | undefined)?.systemPrompt,
        result.addendum,
      ),
    };
  };

  platform.on("before_agent_start", handler);

  return () => {
    unregistered = true;
  };
}

/** Reset the in-memory rule cache. Tests use this to re-read the architecture doc. */
export function _resetLayerRuleCacheForTests(): void {
  rulesCache.clear();
}
