/**
 * Path helpers for the harness pipeline.
 *
 * Mirrors the `src/ultraplan/project-paths.ts` pattern:
 *  - per-session global state under `~/.omp/supipowers/projects/<slug>/harness/<sessionId>/`,
 *  - repo-scoped marker + score files under `<repo>/.omp/supipowers/harness/`,
 *  - persistent slop queue lives under the global path so concurrent worktrees of one repo
 *    converge on a single queue (resolved through `resolveRepoIdentityRootFromFs`).
 *
 * Filename constants are exported so call sites never inline the strings — keeping the
 * `getHarnessXxxPath` family as the only entry point makes the storage layout refactorable.
 */

import path from "node:path";

import type { PlatformPaths } from "../platform/types.js";
import { projectSlugFromRepoRoot } from "../workspace/project-slug.js";
import { resolveRepoIdentityRootFromFs } from "../workspace/repo-root.js";

// ---------------------------------------------------------------------------
// Canonical directory + filename constants.
// ---------------------------------------------------------------------------

/** Root directory under the project slug for harness pipeline state. */
const HARNESS_DIRNAME = "harness";

/** Per-session subdirectory containing every artifact for one pipeline run. */
const HARNESS_SESSIONS_DIRNAME = "sessions";

/** Append-only slop-queue file. JSONL, one record per line. */
export const HARNESS_QUEUE_FILENAME = "queue.jsonl";

/** Aggregate score JSON. Computed at the end of Validate and every GC run. */
export const HARNESS_SCORE_FILENAME = "score.json";

/** Append-only score history. JSONL, one record per Validate / GC computation. */
export const HARNESS_SCORE_HISTORY_FILENAME = "score-history.jsonl";

/** Repo-local marker file. Presence means the harness is installed for this repo. */
export const HARNESS_MARKER_FILENAME = "marker.json";

/** Per-session manifest. Holds HarnessSession state. */
export const HARNESS_MANIFEST_FILENAME = "manifest.json";

/** Per-session artifact filenames. */
export const HARNESS_DISCOVER_FILENAME = "discover.json";
export const HARNESS_DESIGN_SPEC_FILENAME = "design-spec.md";
export const HARNESS_DECISIONS_FILENAME = "decisions.jsonl";
export const HARNESS_VALIDATE_REPORT_FILENAME = "validate-report.json";
export const HARNESS_IMPLEMENT_LOG_FILENAME = "implement-log.jsonl";
export const HARNESS_PIPELINE_LOG_FILENAME = "pipeline-log.jsonl";
export const HARNESS_RESEARCH_DIRNAME = "research";

/** Tier 1 / Tier 2 output paths in the repo. */
export const HARNESS_AGENTS_MD_FILENAME = "AGENTS.md";
export const HARNESS_DOCS_DIRNAME = "docs";
export const HARNESS_DOCS_ARCHITECTURE_FILENAME = "architecture.md";
export const HARNESS_DOCS_GOLDEN_PRINCIPLES_FILENAME = "golden-principles.md";
export const HARNESS_FALLOW_CONFIG_FILENAME = ".fallowrc.json";

// ---------------------------------------------------------------------------
// Internal resolution helpers.
// ---------------------------------------------------------------------------

function resolveProjectIdentityRoot(cwd: string): string {
  return path.resolve(resolveRepoIdentityRootFromFs(cwd));
}

/**
 * Canonical harness root: `~/.omp/supipowers/projects/<slug>/harness`.
 */
export function getHarnessProjectRoot(paths: PlatformPaths, cwd: string): string {
  const repoIdentityRoot = resolveProjectIdentityRoot(cwd);
  const slug = projectSlugFromRepoRoot(repoIdentityRoot);
  return paths.global("projects", slug, HARNESS_DIRNAME);
}

// ---------------------------------------------------------------------------
// Global per-project paths.
// ---------------------------------------------------------------------------

/** Project-scoped persistent slop queue (shared across worktrees). */
export function getHarnessQueuePath(paths: PlatformPaths, cwd: string): string {
  return path.join(getHarnessProjectRoot(paths, cwd), HARNESS_QUEUE_FILENAME);
}

/** Project-scoped score history (JSONL). */
export function getHarnessScoreHistoryPath(paths: PlatformPaths, cwd: string): string {
  return path.join(getHarnessProjectRoot(paths, cwd), HARNESS_SCORE_HISTORY_FILENAME);
}

/** Per-project sessions directory (parent of all per-session dirs). */
export function getHarnessSessionsDir(paths: PlatformPaths, cwd: string): string {
  return path.join(getHarnessProjectRoot(paths, cwd), HARNESS_SESSIONS_DIRNAME);
}

/** Per-session directory. */
export function getHarnessSessionDir(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
): string {
  return path.join(getHarnessSessionsDir(paths, cwd), sessionId);
}

export function getHarnessManifestPath(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
): string {
  return path.join(getHarnessSessionDir(paths, cwd, sessionId), HARNESS_MANIFEST_FILENAME);
}

export function getHarnessDiscoverPath(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
): string {
  return path.join(getHarnessSessionDir(paths, cwd, sessionId), HARNESS_DISCOVER_FILENAME);
}

export function getHarnessResearchDir(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
): string {
  return path.join(getHarnessSessionDir(paths, cwd, sessionId), HARNESS_RESEARCH_DIRNAME);
}

/**
 * Path to a single research topic markdown. Topic is sanitized for filesystem use; callers
 * pass the already-canonical topic slug.
 */
export function getHarnessResearchTopicPath(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  topicSlug: string,
): string {
  return path.join(getHarnessResearchDir(paths, cwd, sessionId), `${topicSlug}.md`);
}

export function getHarnessDesignSpecPath(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
): string {
  return path.join(getHarnessSessionDir(paths, cwd, sessionId), HARNESS_DESIGN_SPEC_FILENAME);
}

export function getHarnessDecisionsPath(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
): string {
  return path.join(getHarnessSessionDir(paths, cwd, sessionId), HARNESS_DECISIONS_FILENAME);
}

export function getHarnessValidateReportPath(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
): string {
  return path.join(
    getHarnessSessionDir(paths, cwd, sessionId),
    HARNESS_VALIDATE_REPORT_FILENAME,
  );
}

export function getHarnessImplementLogPath(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
): string {
  return path.join(getHarnessSessionDir(paths, cwd, sessionId), HARNESS_IMPLEMENT_LOG_FILENAME);
}

export function getHarnessPipelineLogPath(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
): string {
  return path.join(getHarnessSessionDir(paths, cwd, sessionId), HARNESS_PIPELINE_LOG_FILENAME);
}

// ---------------------------------------------------------------------------
// Repo-local paths (committable subset under .omp/supipowers/harness/).
// ---------------------------------------------------------------------------

/** Repo-local harness directory: `<repo>/.omp/supipowers/harness/`. */
export function getHarnessRepoLocalDir(paths: PlatformPaths, cwd: string): string {
  return paths.project(cwd, "harness");
}

/** Marker file path. Presence registers the harness for this repo. */
export function getHarnessMarkerPath(paths: PlatformPaths, cwd: string): string {
  return path.join(getHarnessRepoLocalDir(paths, cwd), HARNESS_MARKER_FILENAME);
}

/** Repo-local score snapshot. Mirrors the global per-project score for committable artifacts. */
export function getHarnessRepoScorePath(paths: PlatformPaths, cwd: string): string {
  return path.join(getHarnessRepoLocalDir(paths, cwd), HARNESS_SCORE_FILENAME);
}

/** Tier 1 — repo-root AGENTS.md. */
export function getHarnessAgentsMdPath(_paths: PlatformPaths, cwd: string): string {
  return path.join(cwd, HARNESS_AGENTS_MD_FILENAME);
}

/** Tier 1 — repo-root docs/architecture.md. */
export function getHarnessArchitectureDocPath(_paths: PlatformPaths, cwd: string): string {
  return path.join(cwd, HARNESS_DOCS_DIRNAME, HARNESS_DOCS_ARCHITECTURE_FILENAME);
}

/** Tier 1 — repo-root docs/golden-principles.md. */
export function getHarnessGoldenPrinciplesPath(_paths: PlatformPaths, cwd: string): string {
  return path.join(cwd, HARNESS_DOCS_DIRNAME, HARNESS_DOCS_GOLDEN_PRINCIPLES_FILENAME);
}

/** Tier 1 — repo-root .fallowrc.json. */
export function getHarnessFallowConfigPath(_paths: PlatformPaths, cwd: string): string {
  return path.join(cwd, HARNESS_FALLOW_CONFIG_FILENAME);
}
