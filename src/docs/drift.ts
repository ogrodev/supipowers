import * as fs from "node:fs";
import * as path from "node:path";
import type { Platform, PlatformPaths } from "../platform/types.js";
import type { DocDriftState, DriftCheckResult, DriftFinding, WorkspaceTarget } from "../types.js";
import { runStructuredAgentSession } from "../quality/ai-session.js";
import { filterPathsForWorkspaceTarget } from "../workspace/path-mapping.js";
import { getTargetStatePath } from "../workspace/state-paths.js";

// ── State persistence ─────────────────────────────────────────

const STATE_FILENAME = "doc-drift.json";

const EMPTY_STATE: DocDriftState = {
  trackedFiles: [],
  lastCommit: null,
  lastRunAt: null,
};

export interface DocDriftScope<TTarget extends WorkspaceTarget = WorkspaceTarget> {
  target: TTarget;
  allTargets: TTarget[];
}

function filterTrackedFilesToScope(
  trackedFiles: string[],
  scope?: DocDriftScope,
): string[] {
  if (!scope) {
    return trackedFiles;
  }

  return filterPathsForWorkspaceTarget(scope.allTargets, scope.target, trackedFiles);
}

export function statePath(paths: PlatformPaths, cwd: string, target?: WorkspaceTarget): string {
  return target ? getTargetStatePath(paths, target, STATE_FILENAME) : paths.project(cwd, STATE_FILENAME);
}

export function loadState(paths: PlatformPaths, cwd: string, scope?: DocDriftScope): DocDriftState {
  const file = statePath(paths, cwd, scope?.target);
  try {
    const state = JSON.parse(fs.readFileSync(file, "utf-8")) as DocDriftState;
    return {
      ...state,
      trackedFiles: filterTrackedFilesToScope(state.trackedFiles, scope),
    };
  } catch {
    return { ...EMPTY_STATE, trackedFiles: [] };
  }
}

export function saveState(paths: PlatformPaths, cwd: string, state: DocDriftState, target?: WorkspaceTarget): void {
  const file = statePath(paths, cwd, target);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n");
}

// ── File discovery ────────────────────────────────────────────

/** Known documentation file patterns to discover via git ls-files */
const DOC_GLOBS = ["*.md", "*.txt", "*.rst", "docs/*", "*.mdx"];

/**
 * Directory segments that hold agentic workflows, skills, or prompt
 * templates — not project documentation a human would maintain.
 * Matched as path segments (e.g. `src/review/prompts/foo.md` matches `prompts`).
 */
const AGENTIC_DIRS = [
  "skills",
  "commands",
  "prompts",
  "default-agents",
  "test",
  "tests",
  "__tests__",
];

/** Filenames that are agentic artifacts regardless of directory */
const AGENTIC_NAMES = new Set(["SKILL.md", "SYSTEM.md"]);

/** Returns true if the file looks like project documentation, not an agentic workflow artifact */
export function isProjectDoc(filePath: string): boolean {
  const segments = filePath.toLowerCase().split("/");

  // Exclude if any path segment is a known agentic directory
  for (const seg of segments) {
    for (const dir of AGENTIC_DIRS) {
      if (seg === dir) return false;
    }
  }

  // Exclude agentic filenames anywhere in the tree
  const basename = path.basename(filePath);
  if (AGENTIC_NAMES.has(basename)) return false;

  return true;
}

export async function discoverDocFiles(
  platform: Platform,
  cwd: string,
  scope?: DocDriftScope,
): Promise<string[]> {
  const result = await platform.exec(
    "git",
    ["ls-files", "--", ...DOC_GLOBS],
    { cwd },
  );
  if (result.code !== 0) return [];

  const files = [...new Set(
    result.stdout
      .split("\n")
      .map((f) => f.trim())
      .filter((f) => f.length > 0 && isProjectDoc(f)),
  )].sort();

  return scope
    ? filterPathsForWorkspaceTarget(scope.allTargets, scope.target, files).sort()
    : files;
}

// ── Git helpers ───────────────────────────────────────────────

export async function getHeadCommit(
  platform: Platform,
  cwd: string,
): Promise<string | null> {
  const result = await platform.exec("git", ["rev-parse", "HEAD"], { cwd });
  if (result.code !== 0) return null;
  return result.stdout.trim() || null;
}

export async function getDiffFilesSince(
  platform: Platform,
  cwd: string,
  sinceCommit: string,
): Promise<string[]> {
  const result = await platform.exec(
    "git",
    ["diff", "--name-only", `${sinceCommit}..HEAD`],
    { cwd },
  );
  if (result.code !== 0) return [];
  return result.stdout
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
}

// ── Doc content reading ───────────────────────────────────────

export function readTrackedDocs(cwd: string, files: string[]): Map<string, string> {
  const docs = new Map<string, string>();
  for (const file of files) {
    const abs = path.join(cwd, file);
    try {
      docs.set(file, fs.readFileSync(abs, "utf-8"));
    } catch {
      // File was deleted — still include it so the LLM knows
      docs.set(file, "[FILE DELETED]");
    }
  }
  return docs;
}

// ── Grouping ──────────────────────────────────────────────────

export interface DocDriftGroup {
  docs: string[];
  changedFiles: string[];
}

/**
 * Extracts affinity stems from a doc file path.
 * "docs/review.md" → ["review"], "docs/planning/guide.md" → ["planning"]
 * Top-level files (README.md, AGENTS.md) → [] (catch-all group)
 */
function docAffinityStems(docPath: string): string[] {
  const dir = path.dirname(docPath);
  const stem = path.basename(docPath, path.extname(docPath)).toLowerCase();

  // Top-level docs have no specific affinity
  if (dir === ".") return [];

  // Use the first directory segment under docs/ (or the dir itself)
  const segments = dir.split("/").filter((s) => s !== "docs" && s.length > 0);
  const stems: string[] = [];
  if (segments.length > 0) stems.push(segments[0].toLowerCase());
  if (stem !== "index" && stem !== "readme") stems.push(stem);
  return [...new Set(stems)];
}

/**
 * Groups doc files with their related code changes by directory affinity.
 * Unmatched changed files go to the top-level docs group.
 */
export function groupDocsByAffinity(
  trackedFiles: string[],
  changedFiles: string[],
): DocDriftGroup[] {
  // Separate top-level docs from scoped docs
  const topLevelDocs: string[] = [];
  const scopedGroups = new Map<string, { docs: string[]; changedFiles: string[] }>();

  for (const doc of trackedFiles) {
    const stems = docAffinityStems(doc);
    if (stems.length === 0) {
      topLevelDocs.push(doc);
    } else {
      // Use the first stem as group key
      const key = stems[0];
      if (!scopedGroups.has(key)) {
        scopedGroups.set(key, { docs: [], changedFiles: [] });
      }
      scopedGroups.get(key)!.docs.push(doc);
    }
  }

  const unmatchedChanges: string[] = [];

  for (const changed of changedFiles) {
    const changedLower = changed.toLowerCase();
    const changedDir = path.dirname(changedLower);
    const changedSegments = changedDir.split("/");

    // Find best matching scoped group
    let matched = false;
    for (const [stem, group] of scopedGroups) {
      if (changedSegments.some((s) => s === stem) || changedLower.includes(`/${stem}/`)) {
        group.changedFiles.push(changed);
        matched = true;
        break;
      }
    }
    if (!matched) {
      unmatchedChanges.push(changed);
    }
  }

  const groups: DocDriftGroup[] = [];

  // Add scoped groups
  for (const group of scopedGroups.values()) {
    groups.push({ docs: group.docs, changedFiles: group.changedFiles });
  }

  // Add top-level group with unmatched changes
  if (topLevelDocs.length > 0) {
    groups.push({ docs: topLevelDocs, changedFiles: unmatchedChanges });
  }

  return groups;
}

// ── Sub-agent prompt ──────────────────────────────────────────

export function buildSubAgentPrompt(group: DocDriftGroup, isFirstRun: boolean): string {
  const parts: string[] = [
    `You are a documentation drift checker. Your job is to review tracked documentation files against recent code changes and identify drift.`,
    ``,
    `<critical>`,
    `You MUST read skill://create-readme before assessing documentation quality.`,
    `</critical>`,
    ``,
    `## Your Assignment`,
    ``,
    `Check these documentation files for accuracy against the current codebase:`,
  ];

  for (const doc of group.docs) {
    parts.push(`- \`${doc}\``);
  }

  if (!isFirstRun && group.changedFiles.length > 0) {
    parts.push(
      ``,
      `## Code Changes to Consider`,
      ``,
      `These source files changed since the last documentation check:`,
    );
    for (const f of group.changedFiles) {
      parts.push(`- \`${f}\``);
    }
    parts.push(
      ``,
      `Read the documentation files and the changed source files. Compare them to identify:`,
    );
  } else {
    parts.push(
      ``,
      `This is a full documentation audit. Read each documentation file and compare against the current codebase:`,
    );
  }

  parts.push(
    ``,
    `1. **Factual inaccuracies**: wrong names, missing parameters, removed features, changed behavior, outdated examples`,
    `2. **Missing documentation**: new commands, features, config options, subcommands that exist in code but not in docs`,
    `3. **Structural gaps**: important sections that should exist based on the codebase but don't`,
    ``,
    `Rules:`,
    `- Do NOT flag style, wording, or formatting issues`,
    `- Do NOT suggest restructuring existing content`,
    `- Only flag things that are factually wrong or missing`,
    `- If documentation is accurate, say so`,
    ``,
    `Respond with a JSON object:`,
    `{`,
    `  "findings": [`,
    `    {`,
    `      "file": "path/to/doc.md",`,
    `      "description": "What is wrong or missing",`,
    `      "severity": "info" | "warning" | "error",`,
    `      "relatedFiles": ["path/to/source.ts"]`,
    `    }`,
    `  ],`,
    `  "status": "ok" | "drifted"`,
    `}`,
    ``,
    `Set status to "drifted" if ANY findings exist, "ok" if all docs are accurate.`,
    `Respond ONLY with the JSON object, no other text.`,
  );

  return parts.join("\n");
}

// ── Response parsing ──────────────────────────────────────────

export function parseDriftFindings(text: string): { findings: DriftFinding[]; status: string } {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed.findings)) {
        const findings: DriftFinding[] = parsed.findings
          .filter(
            (f: any) =>
              typeof f.file === "string" &&
              typeof f.description === "string",
          )
          .map((f: any) => ({
            file: f.file,
            description: f.description,
            severity: f.severity === "warning" || f.severity === "error" ? f.severity : "info",
            ...(Array.isArray(f.relatedFiles) ? { relatedFiles: f.relatedFiles } : {}),
          }));
        return { findings, status: parsed.status === "ok" ? "ok" : "drifted" };
      }
    }
  } catch {
    // Fall through
  }

  // Fallback: treat unparseable response as potential drift
  const lower = text.toLowerCase();
  const likelyDrifted =
    lower.includes("inaccura") ||
    lower.includes("outdated") ||
    lower.includes("missing") ||
    lower.includes("drift");
  return {
    findings: likelyDrifted
      ? [{ file: "unknown", description: text.slice(0, 200), severity: "warning" }]
      : [],
    status: likelyDrifted ? "drifted" : "ok",
  };
}

// ── Sub-agent runner ──────────────────────────────────────────

async function runDriftSubAgent(
  createAgentSession: Platform["createAgentSession"],
  group: DocDriftGroup,
  isFirstRun: boolean,
  cwd: string,
): Promise<{ findings: DriftFinding[]; status: string }> {
  const prompt = buildSubAgentPrompt(group, isFirstRun);
  const result = await runStructuredAgentSession(
    createAgentSession.bind(undefined) as any,
    { cwd, prompt },
  );
  if (result.status !== "ok" || !result.finalText) {
    return { findings: [], status: "error" };
  }
  return parseDriftFindings(result.finalText);
}

// ── Orchestrator ──────────────────────────────────────────────

/**
 * Checks tracked docs for drift using parallel sub-agents.
 * Returns null to skip silently, or a DriftCheckResult with per-doc findings.
 */
export async function checkDocDrift(
  platform: Platform,
  cwd: string,
  scope?: DocDriftScope,
): Promise<DriftCheckResult | null> {
  const state = loadState(platform.paths, cwd, scope);
  if (state.trackedFiles.length === 0) return null;

  let changedFiles: string[] = [];
  const isFirstRun = !state.lastCommit;

  if (!isFirstRun) {
    const diffFiles = await getDiffFilesSince(platform, cwd, state.lastCommit!);
    changedFiles = scope
      ? filterPathsForWorkspaceTarget(scope.allTargets, scope.target, diffFiles)
      : diffFiles;
    if (changedFiles.length === 0) return null;
  }

  // Group docs with relevant code changes
  const groups = groupDocsByAffinity(state.trackedFiles, changedFiles);
  if (groups.length === 0) return null;

  // Dispatch parallel sub-agents
  const results = await Promise.all(
    groups.map((group) =>
      runDriftSubAgent(
        platform.createAgentSession.bind(platform),
        group,
        isFirstRun,
        cwd,
      ),
    ),
  );

  // Aggregate findings
  const allFindings: DriftFinding[] = [];
  for (const result of results) {
    allFindings.push(...result.findings);
  }

  const drifted = allFindings.length > 0;
  const summary = drifted
    ? `${allFindings.length} finding(s) across ${new Set(allFindings.map((f) => f.file)).size} doc(s)`
    : "All documentation is up to date.";

  return { drifted, summary, findings: allFindings };
}

// ── Doc fix prompt ────────────────────────────────────────────

/**
 * Builds a fix prompt from structured findings. Each finding tells the agent
 * exactly what to fix and in which file, so it only needs to read those files.
 */
export function buildFixPrompt(findings: DriftFinding[]): string {
  const parts: string[] = [
    `You are a documentation fixer. Fix ONLY the issues listed below.`,
    ``,
    `Rules:`,
    `1. Only fix factual inaccuracies and add missing sections for undocumented features`,
    `2. Do NOT rewrite prose, improve wording, or restructure existing content`,
    `3. Preserve each document's existing formatting, tone, and conventions`,
    `4. Keep it concise — match the style of existing documentation`,
    ``,
    `## Findings to fix`,
    ``,
  ];

  // Group findings by file for clarity
  const byFile = new Map<string, DriftFinding[]>();
  for (const f of findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file)!.push(f);
  }

  for (const [file, fileFindings] of byFile) {
    parts.push(`### \`${file}\``);
    for (const f of fileFindings) {
      parts.push(`- [${f.severity}] ${f.description}`);
      if (f.relatedFiles?.length) {
        parts.push(`  Related source: ${f.relatedFiles.join(", ")}`);
      }
    }
    parts.push(``);
  }

  parts.push(`Read each file listed above, apply the fixes, and write the corrected files.`);
  return parts.join("\n");
}
