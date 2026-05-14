import { createHash } from "node:crypto";
import type { ParsedSkill, PromptSection } from "./analyzer.js";
import { RUNBOOK_EXTENSION_NAME, RUNBOOK_EXTENSION_PATH, RUNBOOK_EXTENSION_SOURCE } from "./runbook-extension-template.js";
import type { TechStack } from "./optimizer.js";

export const STARTUP_OPTIMIZER_MANIFEST_VERSION = 1;
export const TARGET_STARTUP_PROMPT_BYTES = 8_000 * 4;
export const AGENTS_SPLIT_THRESHOLD_BYTES = TARGET_STARTUP_PROMPT_BYTES;

export type OptimizationSourceType = "skill" | "section";
export type RuleMode = "ttsr" | "rulebook";

export interface OptimizationSource {
  sourceId: string;
  sourceName: string;
  sourceType: OptimizationSourceType;
  sourceHash: string;
  slug: string;
  bytes: number;
  tokens: number;
  content: string;
}

export interface WriteRuleAction {
  kind: "write-rule";
  mode: RuleMode;
  sourceId: string;
  sourceName: string;
  sourceHash: string;
  slug: string;
  targetPath: string;
  sourceBytes: number;
  estimatedSavedBytes: number;
  sourceContent: string;
  condition?: string;
  description?: string;
  triggers?: string;
  scope?: string;
}

export interface WriteCommandAction {
  kind: "write-command";
  sourceId: string;
  sourceName: string;
  sourceHash: string;
  slug: string;
  commandName: string;
  targetPath: string;
  sourceBytes: number;
  estimatedSavedBytes: number;
  sourceContent: string;
  description?: string;
}

export interface WriteExtensionAction {
  kind: "write-extension";
  sourceId: string;
  sourceName: string;
  sourceHash: string;
  slug: string;
  extensionName: string;
  targetPath: string;
  sourceBytes: number;
  estimatedSavedBytes: number;
  sourceContent: string;
}

export type ManualDisableReason = "source-still-loaded" | "tech-stack-irrelevant";

export interface ManualDisableAction {
  kind: "manual-disable";
  reason: ManualDisableReason;
  sourceId: string;
  sourceName: string;
  sourceHash: string;
  slug: string;
  remediation: string;
}

export interface ManualAgentsSplitAction {
  kind: "manual-agents-split";
  sourceId: string;
  sourceName: string;
  sourceHash: string;
  sourceBytes: number;
  thresholdBytes: number;
  remediation: string;
}

export type ManualOptimizationAction = ManualDisableAction | ManualAgentsSplitAction;
export type OptimizationAction = WriteRuleAction | WriteCommandAction | WriteExtensionAction | ManualOptimizationAction;

export interface OptimizationWarning {
  code: string;
  message: string;
  sourceId?: string;
}

export interface OptimizationPlan {
  version: typeof STARTUP_OPTIMIZER_MANIFEST_VERSION;
  targetBytes: number;
  sourceSetHash: string;
  beforeBytes: number;
  estimatedAfterBytes: number;
  estimatedSavedBytes: number;
  sources: OptimizationSource[];
  actions: OptimizationAction[];
  warnings: OptimizationWarning[];
}

export interface BuildOptimizationPlanInput {
  /**
   * Original system prompt text. Used as the authoritative `beforeBytes` so the
   * optimizer estimate matches the actual prompt size, even when `sections` and
   * `skills` overlap (e.g. when `# Skills` content is also captured inside a
   * containing section).
   */
  prompt: string;
  sections: PromptSection[];
  skills: ParsedSkill[];
  techStack: TechStack;
}

interface TtsrRuleOptions {
  condition: string;
  triggers?: string;
  scope?: string;
}


interface BehaviorSkillSpec {
  mode: "ttsr";
  condition: string;
  triggers: string;
  scope: string;
}

const BEHAVIOR_SKILLS: Record<string, BehaviorSkillSpec> = {
  debugging: {
    mode: "ttsr",
    condition: String.raw`\b(?:debug(?:ging)?|root\s+cause|investigate|repro(?:duce|duction)?|failing\s+test)\b`,
    triggers: "debugging, root cause, investigate, reproduce, failing test",
    scope: "text",
  },
  tdd: {
    mode: "ttsr",
    condition: String.raw`\b(?:tdd|test\s+first|failing\s+test\s+first|red[-\s]+green[-\s]+refactor)\b`,
    triggers: "TDD, test first, failing test first, red-green-refactor",
    scope: "text",
  },
  verification: {
    mode: "ttsr",
    condition: String.raw`\b(?:verify|verification|evidence|prove|proof|run\s+(?:the\s+)?(?:focused\s+)?tests?)\b`,
    triggers: "verify, verification, evidence, proof, run focused tests",
    scope: "text",
  },
  "receiving-code-review": {
    mode: "ttsr",
    condition: String.raw`\b(?:pr\s+feedback|code\s+review\s+comments?|reviewer\s+feedback|review\s+comments?)\b`,
    triggers: "PR feedback, code review comments, reviewer feedback",
    scope: "text",
  },
};

const TECH_STACK_SKILLS: Record<string, { anyOf: Array<keyof TechStack>; values: string[] }> = {
  "shadcn-ui": {
    anyOf: ["frameworks", "tools"],
    values: ["react", "next", "shadcn", "tailwind"],
  },
  "better-auth": {
    anyOf: ["languages", "frameworks", "tools", "runtime"],
    values: ["typescript", "javascript", "react", "next", "node", "bun"],
  },
  playwright: {
    anyOf: ["tools"],
    values: ["playwright"],
  },
};

const WORKFLOW_COMMAND_SKILLS = new Set([
  "rewrite-page-copy",
  "e2e-test-orchestrator",
  "design-refiner",
  "workflow-extractor",
  "engaging-writing",
  "brand-namer",
  "brand-forge",
  "product-linear-issues",
  "skill-auditor",
  "caveman",
  "caveman-compress",
  "security-threat-model",
  "brand-migrate",
  "audit",
  "setup-tyndale",
  "setup-tyndale-local",
  "writing-commands",
  "playwright",
  "ui-design",
  "quick-setup",
  "planning",
  "fix-pr",
  "create-readme",
  "translate-book",
]);


const ACTION_KIND_ORDER: Record<OptimizationAction["kind"], number> = {
  "write-rule": 0,
  "write-command": 1,
  "write-extension": 2,
  "manual-disable": 3,
  "manual-agents-split": 4,
};

export function hashOptimizationSource(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function slugifyOptimizationSource(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "source";
}

export function sourceSetHash(sources: Pick<OptimizationSource, "sourceId" | "sourceHash">[]): string {
  const body = [...sources]
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId))
    .map((source) => `${source.sourceId}:${source.sourceHash}`)
    .join("\n");
  return hashOptimizationSource(body);
}

export function buildOptimizationPlan(input: BuildOptimizationPlanInput): OptimizationPlan {
  const sources = buildSources(input.sections, input.skills);
  const actions: OptimizationAction[] = [];
  const warnings: OptimizationWarning[] = [];

  actions.push(buildRunbookExtensionAction());

  for (const source of sources) {
    if (source.sourceType === "skill") {
      const canonicalName = source.sourceName.toLowerCase();
      const behavior = BEHAVIOR_SKILLS[canonicalName];
      if (behavior) {
        actions.push(buildWriteRuleAction(source, behavior.mode, {
          condition: behavior.condition,
          triggers: behavior.triggers,
          scope: behavior.scope,
        }));
        actions.push(buildManualDisableAction(source, "source-still-loaded"));
        continue;
      }

      if (WORKFLOW_COMMAND_SKILLS.has(canonicalName)) {
        actions.push(buildWriteCommandAction(source));
        actions.push(buildManualDisableAction(source, "source-still-loaded"));
        continue;
      }

      if (isTechStackIrrelevant(canonicalName, input.techStack)) {
        actions.push(buildManualDisableAction(source, "tech-stack-irrelevant"));
        continue;
      }

      actions.push(buildWriteRuleAction(source, "rulebook"));
      actions.push(buildManualDisableAction(source, "source-still-loaded"));
      continue;
    }

    if (source.sourceName === "AGENTS.md" && source.bytes > AGENTS_SPLIT_THRESHOLD_BYTES) {
      actions.push({
        kind: "manual-agents-split",
        sourceId: source.sourceId,
        sourceName: source.sourceName,
        sourceHash: source.sourceHash,
        sourceBytes: source.bytes,
        thresholdBytes: AGENTS_SPLIT_THRESHOLD_BYTES,
        remediation:
          "Split oversized AGENTS.md guidance into smaller scoped files or managed rules so startup context stays under the L6 target.",
      });
    }
  }

  // beforeBytes comes from the original prompt, not from summing source bytes:
  // sections and skills overlap in practice (e.g. `# Skills` content appears
  // inside a containing section), so summing would double-count.
  const beforeBytes = byteLength(input.prompt);

  // Sources whose content the user is expected to actually remove from the
  // startup prompt: write-rule companions, write-command companions, and
  // manual-disable actions. Deduplicated by sourceId because generated artifacts
  // are paired with `source-still-loaded` manual-disable records.
  const removedSourceIds = new Set<string>();
  for (const action of actions) {
    if (action.kind === "write-rule" || action.kind === "write-command" || action.kind === "manual-disable") {
      removedSourceIds.add(action.sourceId);
    }
  }
  const estimatedSavedBytes = sources
    .filter((source) => removedSourceIds.has(source.sourceId))
    .reduce((sum, source) => sum + source.bytes, 0);
  const estimatedAfterBytes = Math.max(0, beforeBytes - estimatedSavedBytes);

  return {
    version: STARTUP_OPTIMIZER_MANIFEST_VERSION,
    targetBytes: TARGET_STARTUP_PROMPT_BYTES,
    sourceSetHash: sourceSetHash(sources),
    beforeBytes,
    estimatedAfterBytes,
    estimatedSavedBytes,
    sources,
    actions: sortActions(actions),
    warnings,
  };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function buildSources(sections: PromptSection[], skills: ParsedSkill[]): OptimizationSource[] {
  const sourceMap = new Map<string, OptimizationSource>();

  for (const skill of skills) {
    const sourceName = skill.name.trim();
    const canonicalName = sourceName.toLowerCase();
    const sourceId = `skill:${canonicalName}`;
    const content = canonicalSourceContent(skill.content);
    sourceMap.set(sourceId, {
      sourceId,
      sourceName: canonicalName,
      sourceType: "skill",
      sourceHash: hashOptimizationSource(content),
      slug: slugifyOptimizationSource(sourceId),
      bytes: byteLength(content),
      tokens: Math.ceil(content.length / 4),
      content,
    });
  }

  for (const section of sections) {
    const sourceName = section.label.trim();
    const sourceId = `section:${sourceName}`;
    const content = canonicalSourceContent(section.content);
    sourceMap.set(sourceId, {
      sourceId,
      sourceName,
      sourceType: "section",
      sourceHash: hashOptimizationSource(content),
      slug: slugifyOptimizationSource(sourceId),
      bytes: byteLength(content),
      tokens: Math.ceil(content.length / 4),
      content,
    });
  }

  return [...sourceMap.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId));
}

/**
 * Canonicalize a source body for hashing/sizing: strip a single trailing newline.
 *
 * The renderer adds a trailing newline at file write time for POSIX-friendly EOF,
 * and the parser strips it back. Hashing canonical (no-trailing-newline) form keeps
 * the round trip stable regardless of whether the caller passed content with or
 * without an EOF newline.
 */
function canonicalSourceContent(content: string): string {
  if (content.endsWith("\r\n")) return content.slice(0, -2);
  if (content.endsWith("\n")) return content.slice(0, -1);
  return content;
}

function buildWriteRuleAction(
  source: OptimizationSource,
  mode: RuleMode,
  ttsr?: TtsrRuleOptions,
): WriteRuleAction {
  return {
    kind: "write-rule",
    mode,
    sourceId: source.sourceId,
    sourceName: source.sourceName,
    sourceHash: source.sourceHash,
    slug: source.slug,
    targetPath: `.omp/rules/${source.slug}.md`,
    sourceBytes: source.bytes,
    estimatedSavedBytes: source.bytes,
    sourceContent: source.content,
    ...(ttsr ? { condition: ttsr.condition, triggers: ttsr.triggers, scope: ttsr.scope } : {}),
  };
}

function buildWriteCommandAction(source: OptimizationSource): WriteCommandAction {
  const commandName = slugifyOptimizationSource(source.sourceName);
  return {
    kind: "write-command",
    sourceId: source.sourceId,
    sourceName: source.sourceName,
    sourceHash: source.sourceHash,
    slug: source.slug,
    commandName,
    targetPath: `.omp/commands/${commandName}.md`,
    sourceBytes: source.bytes,
    estimatedSavedBytes: source.bytes,
    sourceContent: source.content,
    description: `Run the ${source.sourceName} workflow on demand.`,
  };
}

function buildRunbookExtensionAction(): WriteExtensionAction {
  const sourceContent = canonicalSourceContent(RUNBOOK_EXTENSION_SOURCE);
  const sourceBytes = byteLength(sourceContent);
  return {
    kind: "write-extension",
    sourceId: "extension:runbook",
    sourceName: RUNBOOK_EXTENSION_NAME,
    sourceHash: hashOptimizationSource(sourceContent),
    slug: "extension-runbook",
    extensionName: RUNBOOK_EXTENSION_NAME,
    targetPath: RUNBOOK_EXTENSION_PATH,
    sourceBytes,
    estimatedSavedBytes: 0,
    sourceContent,
  };
}

function buildManualDisableAction(
  source: OptimizationSource,
  reason: ManualDisableReason,
): ManualDisableAction {
  const remediation = reason === "tech-stack-irrelevant"
    ? `Disable ${source.sourceName}; it is not relevant to the detected project tech stack.`
    : `Disable the original ${source.sourceName} skill once the managed rule is available so startup context is actually reduced.`;

  return {
    kind: "manual-disable",
    reason,
    sourceId: source.sourceId,
    sourceName: source.sourceName,
    sourceHash: source.sourceHash,
    slug: source.slug,
    remediation,
  };
}

function isTechStackIrrelevant(skillName: string, techStack: TechStack): boolean {
  const rule = TECH_STACK_SKILLS[skillName];
  if (!rule) return false;

  for (const key of rule.anyOf) {
    const value = techStack[key];
    if (Array.isArray(value)) {
      if (value.some((entry) => rule.values.includes(entry.toLowerCase()))) return false;
    } else if (typeof value === "string" && rule.values.includes(value.toLowerCase())) {
      return false;
    }
  }

  return true;
}

function sortActions(actions: OptimizationAction[]): OptimizationAction[] {
  return [...actions].sort((a, b) => {
    const kindDelta = ACTION_KIND_ORDER[a.kind] - ACTION_KIND_ORDER[b.kind];
    if (kindDelta !== 0) return kindDelta;
    const sourceDelta = a.sourceId.localeCompare(b.sourceId);
    if (sourceDelta !== 0) return sourceDelta;
    if (a.kind === "write-rule" && b.kind === "write-rule") {
      return a.mode.localeCompare(b.mode);
    }
    return 0;
  });
}
