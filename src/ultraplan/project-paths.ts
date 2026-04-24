import path from "node:path";
import type { PlatformPaths } from "../platform/types.js";
import type { UltraPlanStackId } from "../types.js";
import { resolveRepoIdentityRootFromFs, resolveRepoRootFromFs } from "../workspace/repo-root.js";
import { projectSlugFromRepoRoot } from "../workspace/project-slug.js";

// Canonical directory name for the UltraPlan namespace under the global state root. Kept here so
// no other UltraPlan module needs to know this token.
const ULTRAPLANS_DIR = "ultraplans";

// Canonical artifact filenames. Exported so UltraPlan command/presenter code that builds manifest
// references does not need to inline the strings (centralization-scan guardrail from the delta
// spec §1).
export const ULTRAPLAN_AUTHORED_JSON_FILENAME = "authored.json";
export const ULTRAPLAN_AUTHORED_MARKDOWN_FILENAME = "authored.md";
export const ULTRAPLAN_MANIFEST_FILENAME = "manifest.json";
export const ULTRAPLAN_INDEX_FILENAME = "index.json";
export const ULTRAPLAN_EXECUTION_LOG_FILENAME = "execution-log.jsonl";
export const ULTRAPLAN_HOOKS_LOG_FILENAME = "hooks-log.jsonl";
export const ULTRAPLAN_RUNTIME_TRACKER_FILENAME = "runtime-tracker.json";
export const ULTRAPLAN_MIGRATION_RECORD_FILENAME = "migration.json";
const ULTRAPLAN_BATCH_RUNS_DIRNAME = "batch-runs";
export const ULTRAPLAN_BATCH_RUN_FILENAME = "run.json";
export const ULTRAPLAN_BATCH_JOURNAL_FILENAME = "journal.jsonl";
export const ULTRAPLAN_ACTIVE_BATCH_RUN_FILENAME = "active-run.json";

/**
 * Resolve the active checkout root for the given cwd. Legacy repo-local helpers still target the
 * active checkout, not the canonical UltraPlan identity root.
 */
function resolveCheckoutRoot(cwd: string): string {
  return path.resolve(resolveRepoRootFromFs(cwd));
}

/**
 * Resolve the canonical project identity root for the given cwd. Linked worktrees of one repo
 * must converge on the same identity root so they share one UltraPlan storage location.
 */
function resolveProjectIdentityRoot(cwd: string): string {
  return path.resolve(resolveRepoIdentityRootFromFs(cwd));
}

export function getUltraplanProjectName(cwd: string): string {
  const projectName = path.basename(path.normalize(resolveProjectIdentityRoot(cwd)));
  if (!projectName) {
    throw new Error(`Unable to derive ultraplan project name from cwd: ${cwd}`);
  }
  return projectName;
}

/**
 * Canonical UltraPlan root: `${home}/.omp/supipowers/projects/<projectSlug>/ultraplans`.
 * Every other UltraPlan path helper composes on top of this single function.
 */
export function resolveUltraPlanRoot(paths: PlatformPaths, cwd: string): string {
  const repoIdentityRoot = resolveProjectIdentityRoot(cwd);
  const slug = projectSlugFromRepoRoot(repoIdentityRoot);
  return paths.global("projects", slug, ULTRAPLANS_DIR);
}

/** Project-scoped directory under the global state root (parent of `ultraplans/`). */
export function getUltraplanProjectDir(paths: PlatformPaths, cwd: string): string {
  const repoIdentityRoot = resolveProjectIdentityRoot(cwd);
  const slug = projectSlugFromRepoRoot(repoIdentityRoot);
  return paths.global("projects", slug);
}

export function getUltraplansDir(paths: PlatformPaths, cwd: string): string {
  return resolveUltraPlanRoot(paths, cwd);
}

export function getUltraplanIndexPath(paths: PlatformPaths, cwd: string): string {
  return path.join(resolveUltraPlanRoot(paths, cwd), ULTRAPLAN_INDEX_FILENAME);
}

export function getUltraplanBatchRunsDir(paths: PlatformPaths, cwd: string): string {
  return path.join(resolveUltraPlanRoot(paths, cwd), ULTRAPLAN_BATCH_RUNS_DIRNAME);
}

export function getUltraplanActiveBatchRunPath(paths: PlatformPaths, cwd: string): string {
  return path.join(getUltraplanBatchRunsDir(paths, cwd), ULTRAPLAN_ACTIVE_BATCH_RUN_FILENAME);
}

export function getUltraplanBatchRunDir(paths: PlatformPaths, cwd: string, runId: string): string {
  return path.join(getUltraplanBatchRunsDir(paths, cwd), runId);
}

export function getUltraplanBatchRunPath(paths: PlatformPaths, cwd: string, runId: string): string {
  return path.join(getUltraplanBatchRunDir(paths, cwd, runId), ULTRAPLAN_BATCH_RUN_FILENAME);
}

export function getUltraplanBatchJournalPath(paths: PlatformPaths, cwd: string, runId: string): string {
  return path.join(getUltraplanBatchRunDir(paths, cwd, runId), ULTRAPLAN_BATCH_JOURNAL_FILENAME);
}

export function getUltraplanSessionDir(paths: PlatformPaths, cwd: string, sessionId: string): string {
  return path.join(resolveUltraPlanRoot(paths, cwd), sessionId);
}

export function getUltraplanManifestPath(paths: PlatformPaths, cwd: string, sessionId: string): string {
  return path.join(getUltraplanSessionDir(paths, cwd, sessionId), ULTRAPLAN_MANIFEST_FILENAME);
}

export function getUltraplanAuthoredJsonPath(paths: PlatformPaths, cwd: string, sessionId: string): string {
  return path.join(getUltraplanSessionDir(paths, cwd, sessionId), ULTRAPLAN_AUTHORED_JSON_FILENAME);
}

export function getUltraplanAuthoredMarkdownPath(paths: PlatformPaths, cwd: string, sessionId: string): string {
  return path.join(getUltraplanSessionDir(paths, cwd, sessionId), ULTRAPLAN_AUTHORED_MARKDOWN_FILENAME);
}

export function getUltraplanExecutionLogPath(paths: PlatformPaths, cwd: string, sessionId: string): string {
  return path.join(getUltraplanSessionDir(paths, cwd, sessionId), ULTRAPLAN_EXECUTION_LOG_FILENAME);
}

export function getUltraplanHooksLogPath(paths: PlatformPaths, cwd: string, sessionId: string): string {
  return path.join(getUltraplanSessionDir(paths, cwd, sessionId), ULTRAPLAN_HOOKS_LOG_FILENAME);
}

export function getUltraplanRuntimeTrackerPath(paths: PlatformPaths, cwd: string, sessionId: string): string {
  return path.join(getUltraplanSessionDir(paths, cwd, sessionId), ULTRAPLAN_RUNTIME_TRACKER_FILENAME);
}

export function getUltraplanMigrationRecordPath(paths: PlatformPaths, cwd: string, sessionId: string): string {
  return path.join(getUltraplanSessionDir(paths, cwd, sessionId), ULTRAPLAN_MIGRATION_RECORD_FILENAME);
}

export function getUltraplanReviewDir(paths: PlatformPaths, cwd: string, sessionId: string): string {
  return path.join(getUltraplanSessionDir(paths, cwd, sessionId), "review");
}

export function getUltraplanStackReviewDir(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  stack: UltraPlanStackId,
): string {
  return path.join(getUltraplanReviewDir(paths, cwd, sessionId), stack);
}

export function getUltraplanDomainReviewPath(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  stack: UltraPlanStackId,
  domainId: string,
): string {
  return path.join(getUltraplanStackReviewDir(paths, cwd, sessionId, stack), "domains", `${domainId}.json`);
}

export function getUltraplanStackReviewPath(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  stack: UltraPlanStackId,
): string {
  return path.join(getUltraplanStackReviewDir(paths, cwd, sessionId, stack), "stack.json");
}


// ---------------------------------------------------------------------------
// Legacy (pre-Slice-2) repo-local path helpers. Only the migration engine uses these; after
// migration runs, the legacy directory is renamed and never written to again.
// ---------------------------------------------------------------------------

const LEGACY_DOT_DIR = ".omp";
const LEGACY_PACKAGE_DIR = "supipowers";

export function getLegacyUltraplansDir(cwd: string): string {
  return path.join(resolveCheckoutRoot(cwd), LEGACY_DOT_DIR, LEGACY_PACKAGE_DIR, ULTRAPLANS_DIR);
}

export function getLegacyUltraplanSessionDir(cwd: string, sessionId: string): string {
  return path.join(getLegacyUltraplansDir(cwd), sessionId);
}

export function getLegacyUltraplanIndexPath(cwd: string): string {
  return path.join(getLegacyUltraplansDir(cwd), ULTRAPLAN_INDEX_FILENAME);
}