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
 */
export function computeLayerAddendum(input: {
  cwd: string;
  candidateFile: string | null;
  config: HarnessHookConfig["layer_context_inject"];
  /** Override the resolved architecture-doc path; tests use this to point at a fixture. */
  archPath?: string;
}): LayerContextInjectionResult {
  if (!input.config.enabled) return { addendum: "", reason: "disabled" };
  if (!input.candidateFile) return { addendum: "", reason: "no candidate file" };
  const archPath = input.archPath ?? `${input.cwd}/docs/architecture.md`;
  const rules = loadRules(archPath);
  if (rules.length === 0) return { addendum: "", reason: "no rules parsed" };
  const rule = resolveLayerForFile(input.candidateFile, rules);
  if (!rule) return { addendum: "", reason: "no rule matches candidate file" };
  const addendum = buildLayerAddendum(input.candidateFile, rule, input.config.addendum_max_chars);
  return { addendum, reason: "matched" };
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
  const handler = (event: unknown, ctx: unknown): { systemPrompt: string } | undefined => {
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

    const basePrompt = (event as { systemPrompt?: string } | undefined)?.systemPrompt ?? "";
    return { systemPrompt: `${result.addendum}\n\n${basePrompt}` };
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
