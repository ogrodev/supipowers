import type { ParsedSkill, PromptSection } from "./analyzer.js";
import { parseManagedRule } from "./rule-renderer.js";
import {
  hashOptimizationSource,
  type ManualOptimizationAction,
  type RuleMode,
} from "./startup-optimizer.js";
import { parseManagedTokenignore } from "./tokenignore.js";

export interface StartupOptimizerManifestRule {
  path: string;
  mode: RuleMode;
  sourceId: string;
  sourceName: string;
  sourceHash: string;
  slug: string;
  sourceBytes: number;
  condition?: string;
  description?: string;
}

export interface StartupOptimizerManifest {
  version: 1;
  targetBytes: number;
  sourceSetHash: string;
  beforeBytes: number;
  estimatedAfterBytes: number;
  estimatedSavedBytes: number;
  rules: StartupOptimizerManifestRule[];
  tokenignore: {
    path: string;
    entries: string[];
    hash: string;
  };
  manualActions: ManualOptimizationAction[];
}

export type StartupCheckStatus = "pass" | "warn" | "fail";

export type StartupCheckReason =
  | "missing-manifest"
  | "malformed-manifest"
  | "missing-rule"
  | "unmanaged-rule"
  | "malformed-rule"
  | "rule-drift"
  | "rule-body-drift"
  | "tokenignore-drift"
  | "still-loaded-source"
  | "unresolved-manual-action"
  | "prompt-over-target"
  | "prompt-unavailable";

export interface StartupCheckIssue {
  severity: "fail" | "warn";
  reason: StartupCheckReason;
  path?: string;
  sourceId?: string;
  message: string;
  remediation: string;
}

export interface StartupCheckInput {
  manifestPath: string;
  manifestText: string | null | undefined;
  ruleFiles: Record<string, string | null | undefined>;
  tokenignorePath: string;
  tokenignoreText: string | null | undefined;
  currentPrompt: string | null | undefined;
  currentSkills: ParsedSkill[];
  currentSections: PromptSection[];
}

export interface StartupCheckReport {
  status: StartupCheckStatus;
  issues: StartupCheckIssue[];
  manifest: StartupOptimizerManifest | null;
  manifestPath: string;
  currentBytes: number | null;
  targetBytes: number | null;
  beforeBytes: number | null;
  afterBytes: number | null;
  sourceSetHash: string | null;
}

export function runStartupCheck(input: StartupCheckInput): StartupCheckReport {
  if (input.currentPrompt == null) {
    return {
      status: "fail",
      issues: [issue("prompt-unavailable", {
        path: input.manifestPath,
        message: "Current system prompt is unavailable, so L6 savings cannot be proven.",
        remediation: "Run /supi:optimize-context --check inside an OMP session that exposes ctx.getSystemPrompt().",
      })],
      manifest: null,
      manifestPath: input.manifestPath,
      currentBytes: null,
      targetBytes: null,
      beforeBytes: null,
      afterBytes: null,
      sourceSetHash: null,
    };
  }

  const currentBytes = byteLength(input.currentPrompt);
  const manifestResult = parseStartupOptimizerManifest(input.manifestText, input.manifestPath);
  if (typeof manifestResult === "string") {
    const reason: StartupCheckReason = input.manifestText == null ? "missing-manifest" : "malformed-manifest";
    return reportFromIssues(input.manifestPath, null, currentBytes, null, [issue(reason, {
      path: input.manifestPath,
      message: manifestResult,
      remediation: reason === "missing-manifest"
        ? "Run /supi:optimize-context --apply to create the startup optimizer manifest."
        : "Remove or repair the manifest, then rerun /supi:optimize-context --apply.",
    })]);
  }

  const manifest = manifestResult;
  const issues: StartupCheckIssue[] = [];

  for (const rule of manifest.rules) {
    const text = input.ruleFiles[rule.path];
    if (text == null) {
      issues.push(issue("missing-rule", {
        path: rule.path,
        sourceId: rule.sourceId,
        message: `Managed rule file is missing for ${rule.sourceId}.`,
        remediation: "Rerun /supi:optimize-context --apply to regenerate managed rules.",
      }));
      continue;
    }

    const parsed = parseManagedRule(text);
    if (parsed.status === "unmanaged") {
      issues.push(issue("unmanaged-rule", {
        path: rule.path,
        sourceId: rule.sourceId,
        message: `Rule file ${rule.path} is not managed by supipowers.`,
        remediation: "Move the user-authored rule aside or choose a different slug before applying again.",
      }));
      continue;
    }

    if (parsed.status === "malformed") {
      issues.push(issue("malformed-rule", {
        path: rule.path,
        sourceId: rule.sourceId,
        message: `Managed rule ${rule.path} is malformed: ${parsed.error}.`,
        remediation: "Rerun /supi:optimize-context --apply to rewrite the managed rule.",
      }));
      continue;
    }

    const metadata = parsed.metadata;
    const frontmatterDrift = rule.mode === "ttsr"
      ? parsed.frontmatter.condition !== rule.condition
      : (typeof rule.description === "string" && parsed.frontmatter.description !== rule.description);

    if (
      metadata.sourceId !== rule.sourceId ||
      metadata.sourceHash !== rule.sourceHash ||
      metadata.slug !== rule.slug ||
      metadata.mode !== rule.mode ||
      metadata.sourceBytes !== rule.sourceBytes ||
      frontmatterDrift
    ) {
      issues.push(issue("rule-drift", {
        path: rule.path,
        sourceId: rule.sourceId,
        message: `Managed rule ${rule.path} no longer matches the startup optimizer manifest.`,
        remediation: "Rerun /supi:optimize-context --apply to refresh managed artifacts.",
      }));
      continue;
    }

    // Body verification — proves the rule body still matches what was migrated,
    // not just that the supipowers-managed header is intact.
    const actualBodyHash = hashOptimizationSource(parsed.body);
    const actualBodyBytes = byteLength(parsed.body);
    if (actualBodyHash !== rule.sourceHash || actualBodyBytes !== rule.sourceBytes) {
      issues.push(issue("rule-body-drift", {
        path: rule.path,
        sourceId: rule.sourceId,
        message: `Managed rule ${rule.path} body has been modified (hash/size no longer matches the manifest).`,
        remediation: "Rerun /supi:optimize-context --apply to rewrite the managed rule from the current prompt source.",
      }));
    }
  }

  const tokenignore = parseManagedTokenignore(input.tokenignoreText);
  if (
    tokenignore.status !== "managed" ||
    !tokenignore.hashMatches ||
    tokenignore.hash !== manifest.tokenignore.hash ||
    !sameStringSet(tokenignore.entries, manifest.tokenignore.entries)
  ) {
    issues.push(issue("tokenignore-drift", {
      path: input.tokenignorePath,
      message: "Managed .tokenignore block is missing, malformed, or does not match the manifest.",
      remediation: "Rerun /supi:optimize-context --apply to refresh the managed .tokenignore block.",
    }));
  }

  // Skill/section presence proof obligations come from BOTH `manifest.rules`
  // (write-rule sources expected to be disabled) and `manifest.manualActions`
  // (tech-stack-irrelevant disables and AGENTS.md split, neither of which has a
  // generated rule file). Without checking manualActions the previous
  // implementation could return `pass` while required manual steps were never
  // performed.
  const skillSourceIdsToVerify = new Set<string>();
  const sectionSourceIdsToVerify = new Set<string>();
  for (const rule of manifest.rules) {
    if (rule.sourceId.startsWith("skill:")) skillSourceIdsToVerify.add(rule.sourceId);
    else if (rule.sourceId.startsWith("section:")) sectionSourceIdsToVerify.add(rule.sourceId);
  }
  for (const action of manifest.manualActions) {
    if (action.kind !== "manual-disable") continue;
    if (action.sourceId.startsWith("skill:")) skillSourceIdsToVerify.add(action.sourceId);
    else if (action.sourceId.startsWith("section:")) sectionSourceIdsToVerify.add(action.sourceId);
  }

  const reportedSourceIds = new Set<string>();
  for (const skill of input.currentSkills) {
    const sourceId = `skill:${skill.name.trim().toLowerCase()}`;
    if (!skillSourceIdsToVerify.has(sourceId)) continue;
    if (reportedSourceIds.has(sourceId)) continue;
    reportedSourceIds.add(sourceId);
    issues.push(issue("still-loaded-source", {
      sourceId,
      message: `Migrated source ${sourceId} is still loaded in the startup prompt.`,
      remediation: "Disable the original skill/source and restart OMP so the new managed rule is picked up.",
    }));
  }
  for (const section of input.currentSections) {
    const sourceId = `section:${section.label}`;
    if (!sectionSourceIdsToVerify.has(sourceId)) continue;
    if (reportedSourceIds.has(sourceId)) continue;
    reportedSourceIds.add(sourceId);
    issues.push(issue("still-loaded-source", {
      sourceId,
      message: `Migrated section ${sourceId} is still present in the startup prompt.`,
      remediation: "Remove or split the section and restart OMP so the prompt actually shrinks.",
    }));
  }

  // manual-agents-split proof: the AGENTS.md (or named) section must be at or
  // below the threshold the planner recorded.
  for (const action of manifest.manualActions) {
    if (action.kind !== "manual-agents-split") continue;
    const matching = input.currentSections.find((section) => section.label === action.sourceName);
    if (!matching) continue;
    if (matching.bytes > action.thresholdBytes) {
      issues.push(issue("unresolved-manual-action", {
        sourceId: action.sourceId,
        message: `${action.sourceName} is still ${matching.bytes} bytes, above threshold ${action.thresholdBytes}.`,
        remediation: action.remediation,
      }));
    }
  }

  if (currentBytes > manifest.targetBytes) {
    issues.push(issue("prompt-over-target", {
      message: `Current startup prompt is ${currentBytes} bytes, above target ${manifest.targetBytes} bytes.`,
      remediation: "Disable migrated sources, split oversized startup files, then restart OMP before rerunning --check.",
    }));
  }

  return reportFromIssues(input.manifestPath, manifest, currentBytes, manifest.targetBytes, issues);
}

/**
 * Parse and validate a `manifest.json` from disk. Exported so the command and
 * the check share one parser; previously the command had its own ad-hoc
 * partial parser that could accept shapes the real validator would reject.
 *
 * Returns the validated manifest or a human-readable error string.
 */
export function parseStartupOptimizerManifest(
  text: string | null | undefined,
  manifestPath: string,
): StartupOptimizerManifest | string {
  if (text == null) return `Startup optimizer manifest is missing at ${manifestPath}.`;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return `Startup optimizer manifest is malformed: ${(error as Error).message}.`;
  }

  if (!isRecord(parsed)) return "Startup optimizer manifest must be an object.";
  if (parsed.version !== 1) return "Startup optimizer manifest has unsupported version.";
  if (!isFiniteNumber(parsed.targetBytes)) return "Startup optimizer manifest is missing targetBytes.";
  if (typeof parsed.sourceSetHash !== "string") return "Startup optimizer manifest is missing sourceSetHash.";
  if (!isFiniteNumber(parsed.beforeBytes)) return "Startup optimizer manifest is missing beforeBytes.";
  if (!isFiniteNumber(parsed.estimatedAfterBytes)) return "Startup optimizer manifest is missing estimatedAfterBytes.";
  if (!isFiniteNumber(parsed.estimatedSavedBytes)) return "Startup optimizer manifest is missing estimatedSavedBytes.";
  if (!Array.isArray(parsed.rules)) return "Startup optimizer manifest is missing rules.";
  if (!isRecord(parsed.tokenignore)) return "Startup optimizer manifest is missing tokenignore.";
  if (!Array.isArray(parsed.manualActions)) return "Startup optimizer manifest is missing manualActions.";

  const rules: StartupOptimizerManifestRule[] = [];
  for (const candidate of parsed.rules) {
    if (!isRecord(candidate)) return "Startup optimizer manifest has invalid rule entry.";
    if (candidate.mode !== "ttsr" && candidate.mode !== "rulebook") return "Startup optimizer manifest has invalid rule mode.";
    for (const key of ["path", "sourceId", "sourceName", "sourceHash", "slug"] as const) {
      if (typeof candidate[key] !== "string") return `Startup optimizer manifest rule is missing ${key}.`;
    }
    if (!isFiniteNumber(candidate.sourceBytes)) return "Startup optimizer manifest rule is missing sourceBytes.";
    rules.push(candidate as unknown as StartupOptimizerManifestRule);
  }

  if (typeof parsed.tokenignore.path !== "string") return "Startup optimizer manifest tokenignore is missing path.";
  if (!Array.isArray(parsed.tokenignore.entries) || !parsed.tokenignore.entries.every((entry) => typeof entry === "string")) {
    return "Startup optimizer manifest tokenignore has invalid entries.";
  }
  if (typeof parsed.tokenignore.hash !== "string") return "Startup optimizer manifest tokenignore is missing hash.";

  return {
    version: 1,
    targetBytes: parsed.targetBytes,
    sourceSetHash: parsed.sourceSetHash,
    beforeBytes: parsed.beforeBytes,
    estimatedAfterBytes: parsed.estimatedAfterBytes,
    estimatedSavedBytes: parsed.estimatedSavedBytes,
    rules,
    tokenignore: {
      path: parsed.tokenignore.path,
      entries: parsed.tokenignore.entries,
      hash: parsed.tokenignore.hash,
    },
    manualActions: parsed.manualActions as ManualOptimizationAction[],
  };
}

function reportFromIssues(
  manifestPath: string,
  manifest: StartupOptimizerManifest | null,
  currentBytes: number | null,
  targetBytes: number | null,
  issues: StartupCheckIssue[],
): StartupCheckReport {
  const hasFailure = issues.some((candidate) => candidate.severity === "fail");
  const hasWarning = issues.some((candidate) => candidate.severity === "warn");

  return {
    status: hasFailure ? "fail" : hasWarning ? "warn" : "pass",
    issues,
    manifest,
    manifestPath,
    currentBytes,
    targetBytes: targetBytes ?? manifest?.targetBytes ?? null,
    beforeBytes: manifest?.beforeBytes ?? null,
    afterBytes: currentBytes,
    sourceSetHash: manifest?.sourceSetHash ?? null,
  };
}

function issue(reason: StartupCheckReason, input: Omit<StartupCheckIssue, "severity" | "reason">): StartupCheckIssue {
  return { severity: "fail", reason, ...input };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}
