/**
 * Round-trip-stable markdown <-> authored.json serializer for the synth-stage `$EDITOR`
 * gate.
 *
 * Design: the markdown surfaces only the **editable** fields (frontmatter + scenario titles,
 * steps, dependencies, level, status). Non-editable fields (agent slot bindings, proofs,
 * progress summaries, review gates) are preserved from the original draft JSON via the
 * `applyAuthoredPatch` helper. This lets the user re-shape the plan without having to
 * understand the full schema, and keeps the planner's slot/proof choices intact unless the
 * user explicitly re-runs the planner.
 *
 * Format:
 *
 *   ---
 *   sessionId: <id>
 *   title: <title>
 *   goal: <goal>
 *   createdAt: <iso>
 *   updatedAt: <iso>
 *   ---
 *   ## Stack: <stack>
 *
 *   - applicability: applicable
 *
 *   ### Domain: <name> (id=<domain-id>)
 *
 *   #### Scenario: <title> (id=<id>) [level=<unit|integration|e2e>]
 *
 *   - status: planned
 *   - steps:
 *     - step 1
 *     - step 2
 *   - dependencies:
 *     - other-id
 *
 * Comments (`<!-- ... -->`) are tolerated and ignored on parse so we can prepend error
 * annotations to a malformed file without breaking the round-trip.
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type {
  UltraPlanApplicability,
  UltraPlanAuthoredArtifact,
  UltraPlanScenarioLevel,
  UltraPlanScenarioStatus,
  UltraPlanStackId,
} from "../../types.js";
import {
  validateUltraPlanAuthoredArtifact,
  ULTRAPLAN_LEVELS,
  ULTRAPLAN_STACKS,
} from "../contracts.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AuthoredMarkdownParseError {
  line: number | null;
  message: string;
}

/**
 * Editable slice of an authored artifact \u2014 the fields the user can change via `$EDITOR`.
 * Everything not in this struct (agent slots, proofs, progress, review gates, status of
 * stacks/domains) is preserved verbatim from the original draft.
 */
export interface AuthoredEditablePatch {
  sessionId: string;
  title: string;
  goal: string;
  createdAt: string;
  updatedAt: string;
  stacks: AuthoredEditableStack[];
}

export interface AuthoredEditableStack {
  stack: UltraPlanStackId;
  applicability: UltraPlanApplicability;
  domains: AuthoredEditableDomain[];
}

export interface AuthoredEditableDomain {
  id: string;
  name: string;
  scenarios: AuthoredEditableScenario[];
}

export interface AuthoredEditableScenario {
  id: string;
  title: string;
  level: UltraPlanScenarioLevel;
  status: UltraPlanScenarioStatus;
  steps: string[];
  dependencies: string[];
}

export type AuthoredMarkdownParseResult =
  | { ok: true; patch: AuthoredEditablePatch }
  | { ok: false; errors: AuthoredMarkdownParseError[] };

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export function serializeAuthoredToMarkdown(authored: UltraPlanAuthoredArtifact): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(stringifyYaml({
    sessionId: authored.sessionId,
    title: authored.title,
    goal: authored.goal,
    createdAt: authored.createdAt,
    updatedAt: authored.updatedAt,
  }).trimEnd());
  lines.push("---");
  lines.push("");

  for (const stack of authored.stacks) {
    lines.push(`## Stack: ${stack.stack}`);
    lines.push("");
    lines.push(`- applicability: ${stack.applicability}`);
    lines.push("");
    for (const domain of stack.domains) {
      lines.push(`### Domain: ${domain.name} (id=${domain.id})`);
      lines.push("");
      const allScenarios = [...domain.unit, ...domain.integration, ...domain.e2e];
      for (const scenario of allScenarios) {
        lines.push(`#### Scenario: ${scenario.title} (id=${scenario.id}) [level=${scenario.level}]`);
        lines.push("");
        lines.push(`- status: ${scenario.status}`);
        lines.push(`- steps:${scenario.steps.length === 0 ? " []" : ""}`);
        for (const step of scenario.steps) lines.push(`  - ${step}`);
        const deps = scenario.dependencies ?? [];
        lines.push(`- dependencies:${deps.length === 0 ? " []" : ""}`);
        for (const dep of deps) lines.push(`  - ${dep}`);
        lines.push("");
      }
    }
  }

  return lines.join("\n").trimEnd() + "\n";
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const STACK_HEADING = /^##\s+Stack:\s+(.+)$/;
const DOMAIN_HEADING = /^###\s+Domain:\s+(.+?)\s*\(id=([^)]+)\)\s*$/;
const SCENARIO_HEADING = /^####\s+Scenario:\s+(.+?)\s*\(id=([^)]+)\)\s*\[level=(unit|integration|e2e)\]\s*$/;
const FRONTMATTER_DELIM = /^---\s*$/;

interface ListContext {
  key: "steps" | "dependencies";
  items: string[];
}

interface ParserState {
  errors: AuthoredMarkdownParseError[];
  fmRaw: string[];
  stacks: AuthoredEditableStack[];
  currentStack: AuthoredEditableStack | null;
  currentDomain: AuthoredEditableDomain | null;
  currentScenario: AuthoredEditableScenario | null;
  list: ListContext | null;
}

function pushError(state: ParserState, line: number | null, message: string) {
  state.errors.push({ line, message });
}

function flushList(state: ParserState) {
  if (!state.list || !state.currentScenario) return;
  if (state.list.key === "steps") state.currentScenario.steps = state.list.items;
  else state.currentScenario.dependencies = state.list.items;
  state.list = null;
}

function applyScenarioField(state: ParserState, key: string, value: string, line: number) {
  const s = state.currentScenario!;
  switch (key) {
    case "status":
      s.status = value.trim() as UltraPlanScenarioStatus;
      return;
    case "steps":
    case "dependencies": {
      flushList(state);
      if (value.trim() === "[]") {
        if (key === "steps") s.steps = [];
        else s.dependencies = [];
        state.list = null;
      } else {
        state.list = { key, items: [] };
      }
      return;
    }
    default:
      pushError(state, line, `Unknown scenario field: ${key}`);
  }
}

function applyStackField(state: ParserState, key: string, value: string, line: number) {
  const s = state.currentStack!;
  if (key === "applicability") {
    s.applicability = value.trim() as UltraPlanApplicability;
    return;
  }
  // Tolerate unknown stack-level fields (status, etc.) — they are non-editable and round-trip
  // through the original draft via applyAuthoredPatch.
  void line;
}

export function parseAuthoredFromMarkdown(markdown: string): AuthoredMarkdownParseResult {
  const state: ParserState = {
    errors: [],
    fmRaw: [],
    stacks: [],
    currentStack: null,
    currentDomain: null,
    currentScenario: null,
    list: null,
  };

  const rawLines = markdown.split(/\r?\n/);
  let i = 0;

  // Skip leading comment annotations and blank lines.
  while (i < rawLines.length) {
    const t = rawLines[i]!.trim();
    if (t === "" || /^<!--[\s\S]*-->$/.test(t)) {
      i += 1;
      continue;
    }
    break;
  }

  if (i >= rawLines.length || !FRONTMATTER_DELIM.test(rawLines[i]!)) {
    pushError(state, i + 1, "Missing YAML frontmatter; expected --- on the first non-blank, non-comment line.");
    return { ok: false, errors: state.errors };
  }
  i += 1;
  const fmStartIndex = i;
  while (i < rawLines.length && !FRONTMATTER_DELIM.test(rawLines[i]!)) {
    state.fmRaw.push(rawLines[i]!);
    i += 1;
  }
  if (i >= rawLines.length) {
    pushError(state, fmStartIndex, "Frontmatter not terminated by closing ---.");
    return { ok: false, errors: state.errors };
  }
  i += 1;

  let frontmatter: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(state.fmRaw.join("\n"));
    frontmatter = (parsed && typeof parsed === "object") ? (parsed as Record<string, unknown>) : {};
  } catch (error) {
    pushError(state, 1, `Frontmatter YAML parse error: ${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, errors: state.errors };
  }

  for (; i < rawLines.length; i += 1) {
    const raw = rawLines[i]!;
    const lineNo = i + 1;
    const trimmed = raw.trim();

    if (trimmed === "" || /^<!--[\s\S]*-->$/.test(trimmed)) continue;

    const stackMatch = STACK_HEADING.exec(raw);
    if (stackMatch) {
      flushList(state);
      const stackId = stackMatch[1]!.trim() as UltraPlanStackId;
      if (!ULTRAPLAN_STACKS.includes(stackId)) {
        pushError(state, lineNo, `Unknown stack: ${stackId}`);
        continue;
      }
      const next: AuthoredEditableStack = { stack: stackId, applicability: "applicable", domains: [] };
      state.stacks.push(next);
      state.currentStack = next;
      state.currentDomain = null;
      state.currentScenario = null;
      state.list = null;
      continue;
    }

    const domainMatch = DOMAIN_HEADING.exec(raw);
    if (domainMatch) {
      flushList(state);
      if (!state.currentStack) {
        pushError(state, lineNo, "Domain heading without a parent ## Stack heading.");
        continue;
      }
      const domain: AuthoredEditableDomain = {
        id: domainMatch[2]!.trim(),
        name: domainMatch[1]!.trim(),
        scenarios: [],
      };
      state.currentStack.domains.push(domain);
      state.currentDomain = domain;
      state.currentScenario = null;
      state.list = null;
      continue;
    }

    const scenarioMatch = SCENARIO_HEADING.exec(raw);
    if (scenarioMatch) {
      flushList(state);
      if (!state.currentStack || !state.currentDomain) {
        pushError(state, lineNo, "Scenario heading without parent stack and domain.");
        continue;
      }
      const level = scenarioMatch[3]! as UltraPlanScenarioLevel;
      if (!ULTRAPLAN_LEVELS.includes(level)) {
        pushError(state, lineNo, `Unknown scenario level: ${level}`);
        continue;
      }
      const scenario: AuthoredEditableScenario = {
        id: scenarioMatch[2]!.trim(),
        title: scenarioMatch[1]!.trim(),
        level,
        status: "planned",
        steps: [],
        dependencies: [],
      };
      state.currentDomain.scenarios.push(scenario);
      state.currentScenario = scenario;
      state.list = null;
      continue;
    }

    if (/^\s+-\s+/.test(raw) && state.list && state.currentScenario) {
      const item = raw.replace(/^\s+-\s+/, "").trim();
      state.list.items.push(item);
      continue;
    }

    const fieldMatch = /^-\s+([A-Za-z][\w-]*):\s*(.*)$/.exec(raw);
    if (fieldMatch) {
      const key = fieldMatch[1]!;
      const value = fieldMatch[2]!;
      flushList(state);
      if (state.currentScenario) {
        applyScenarioField(state, key, value, lineNo);
      } else if (state.currentStack && !state.currentDomain) {
        applyStackField(state, key, value, lineNo);
      }
      continue;
    }
  }
  flushList(state);

  if (state.errors.length > 0) {
    return { ok: false, errors: state.errors };
  }

  const sessionId = String(frontmatter.sessionId ?? "");
  if (!sessionId) {
    pushError(state, null, "Frontmatter is missing sessionId.");
    return { ok: false, errors: state.errors };
  }

  return {
    ok: true,
    patch: {
      sessionId,
      title: String(frontmatter.title ?? ""),
      goal: String(frontmatter.goal ?? ""),
      createdAt: String(frontmatter.createdAt ?? ""),
      updatedAt: String(frontmatter.updatedAt ?? ""),
      stacks: state.stacks,
    },
  };
}

// ---------------------------------------------------------------------------
// Patch application
// ---------------------------------------------------------------------------

/**
 * Apply an editable patch onto an existing draft authored artifact, then validate the
 * result. Non-editable fields (agentSlots, proofs, progress, review gates, etc.) are
 * preserved from `original`; the patch only touches the visible-in-markdown subset.
 *
 * Scenarios in the patch are matched to scenarios in the original by id; any scenario whose
 * id is not in the original is skipped (its agent-slot bindings would be undefined). Any
 * original scenario whose id is missing from the patch is dropped (the user removed it).
 *
 * Stacks and domains follow the same id-matching rule; new stacks/domains in the patch with
 * no original counterpart cannot be applied because they lack agent-slot bindings, and we
 * surface that as a validation error rather than silently inserting empty data.
 */
export function applyAuthoredPatch(
  original: UltraPlanAuthoredArtifact,
  patch: AuthoredEditablePatch,
): { ok: true; value: UltraPlanAuthoredArtifact } | { ok: false; errors: string[] } {
  if (patch.sessionId !== original.sessionId) {
    return { ok: false, errors: [`Patch sessionId ${patch.sessionId} does not match original ${original.sessionId}`] };
  }

  const originalStacksById = new Map(original.stacks.map((s) => [s.stack, s]));
  const newStacks = [];
  const errors: string[] = [];

  for (const stackPatch of patch.stacks) {
    const originalStack = originalStacksById.get(stackPatch.stack);
    if (!originalStack) {
      errors.push(
        `Stack ${stackPatch.stack} appears in the edited markdown but not in the original draft; new stacks cannot be added through the editor.`,
      );
      continue;
    }

    const originalDomainsById = new Map(originalStack.domains.map((d) => [d.id, d]));
    const newDomains = [];
    for (const domainPatch of stackPatch.domains) {
      const originalDomain = originalDomainsById.get(domainPatch.id);
      if (!originalDomain) {
        errors.push(
          `Domain ${domainPatch.id} (stack ${stackPatch.stack}) appears in the edited markdown but not in the original draft.`,
        );
        continue;
      }
      const originalScenariosById = new Map<string, typeof originalDomain.unit[number]>();
      for (const s of [...originalDomain.unit, ...originalDomain.integration, ...originalDomain.e2e]) {
        originalScenariosById.set(s.id, s);
      }

      const unit = [];
      const integration = [];
      const e2e = [];
      for (const scenarioPatch of domainPatch.scenarios) {
        const originalScenario = originalScenariosById.get(scenarioPatch.id);
        if (!originalScenario) {
          errors.push(
            `Scenario ${scenarioPatch.id} (domain ${domainPatch.id}) appears in the edited markdown but not in the original draft.`,
          );
          continue;
        }
        const merged = {
          ...originalScenario,
          title: scenarioPatch.title,
          level: scenarioPatch.level,
          status: scenarioPatch.status,
          steps: scenarioPatch.steps,
          dependencies: scenarioPatch.dependencies,
        };
        if (merged.level === "unit") unit.push(merged);
        else if (merged.level === "integration") integration.push(merged);
        else e2e.push(merged);
      }

      newDomains.push({
        ...originalDomain,
        name: domainPatch.name,
        unit,
        integration,
        e2e,
      });
    }

    newStacks.push({
      ...originalStack,
      applicability: stackPatch.applicability,
      domains: newDomains,
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const next: UltraPlanAuthoredArtifact = {
    ...original,
    title: patch.title,
    goal: patch.goal,
    updatedAt: patch.updatedAt || original.updatedAt,
    stacks: newStacks,
  };

  const validation = validateUltraPlanAuthoredArtifact(next);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors };
  }
  return { ok: true, value: validation.value };
}

// ---------------------------------------------------------------------------
// Error annotation
// ---------------------------------------------------------------------------

export function annotateParseErrors(markdown: string, errors: AuthoredMarkdownParseError[]): string {
  if (errors.length === 0) return markdown;
  const header: string[] = [];
  header.push("<!-- AUTHORED EDIT ERRORS \u2014 fix the issues below, then save and close to re-validate. -->");
  for (const err of errors) {
    const prefix = err.line !== null ? `[line ${err.line}] ` : "";
    header.push(`<!--   ${prefix}${err.message} -->`);
  }
  header.push("");
  return `${header.join("\n")}\n${markdown}`;
}

export function stripParseErrorAnnotations(markdown: string): string {
  return markdown.replace(
    /^(<!--\s*AUTHORED EDIT ERRORS[\s\S]*?-->\n)((<!--[\s\S]*?-->\n)*)\n?/,
    "",
  );
}
