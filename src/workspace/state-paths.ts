import path from "node:path";
import type { PlatformPaths } from "../platform/types.js";
import type { WorkspaceTarget } from "../types.js";
import { projectSlugFromRepoRoot } from "./project-slug.js";
import { resolveRepoIdentityRootFromFs } from "./repo-root.js";
import { ROOT_WORKSPACE_RELATIVE_DIR, normalizeWorkspaceRelativePath } from "./targets.js";

const WORKSPACES_DIR = "workspaces";
const PROJECTS_DIR = "projects";

function splitWorkspacePath(relativeDir: string): string[] {
  const normalized = normalizeWorkspaceRelativePath(relativeDir);
  return normalized === ROOT_WORKSPACE_RELATIVE_DIR ? [] : normalized.split("/").filter(Boolean);
}

// ──────────────────────────────────────────────────────────────────────────
// Team-shared (local) state: <cwd-or-repoRoot>/.omp/supipowers/<...>
//
// These paths are committed (or at least shareable) across a team clone. Used for
// config.json, model.json, review-agents/config.yml, etc.
// ──────────────────────────────────────────────────────────────────────────

export function getRootStateDir(paths: PlatformPaths, repoRoot: string): string {
  return paths.project(repoRoot);
}

export function getWorkspaceStateDir(
  paths: PlatformPaths,
  repoRoot: string,
  workspaceRelativeDir: string,
): string {
  return path.join(getRootStateDir(paths, repoRoot), WORKSPACES_DIR, ...splitWorkspacePath(workspaceRelativeDir));
}

export function getTargetStateDir(paths: PlatformPaths, target: WorkspaceTarget): string {
  return target.kind === "root"
    ? getRootStateDir(paths, target.repoRoot)
    : getWorkspaceStateDir(paths, target.repoRoot, target.relativeDir);
}

export function getRootConfigPath(paths: PlatformPaths, repoRoot: string): string {
  return path.join(getRootStateDir(paths, repoRoot), "config.json");
}

/**
 * Resolve a team-shared config/data path inside `<cwd>/.omp/supipowers/...`.
 * Use this for files that belong to the repo: project config, model config, review-agent
 * definitions. Do not use this for per-invocation execution state — that goes through
 * {@link getProjectStatePath}.
 */
export function getLocalStatePath(paths: PlatformPaths, cwd: string, ...segments: string[]): string {
  return paths.project(cwd, ...segments);
}

/**
 * Workspace-aware variant of {@link getLocalStatePath}. Root targets resolve under the repo
 * root; workspace targets resolve under `<repo>/.omp/supipowers/workspaces/<rel>/...`.
 */
export function getLocalTargetStatePath(
  paths: PlatformPaths,
  target: WorkspaceTarget,
  ...segments: string[]
): string {
  return path.join(getTargetStateDir(paths, target), ...segments);
}

// ──────────────────────────────────────────────────────────────────────────
// Project-scoped (global) execution state: ~/.omp/supipowers/projects/<slug>/<...>
//
// These paths are keyed by a deterministic slug derived from the repo identity root, so
// multiple clones of the same repo do not collide. Used for plans, reviews, reports,
// debug traces, telemetry, visual/ui-design sessions, etc.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Resolve the project-scoped global state directory for the repo containing `cwd`.
 */
export function getProjectStateDir(paths: PlatformPaths, cwd: string): string {
  const identityRoot = resolveRepoIdentityRootFromFs(cwd);
  const slug = projectSlugFromRepoRoot(identityRoot);
  return paths.global(PROJECTS_DIR, slug);
}

/**
 * Resolve a path inside the project-scoped global state directory for `cwd`.
 * Use this for per-invocation execution artifacts (plans, reviews, reports, debug logs, etc.).
 */
export function getProjectStatePath(
  paths: PlatformPaths,
  cwd: string,
  ...segments: string[]
): string {
  return path.join(getProjectStateDir(paths, cwd), ...segments);
}

/**
 * Resolve the project-scoped global state directory for a specific workspace target.
 * Root targets resolve under `<slug>/`; workspace targets resolve under
 * `<slug>/workspaces/<rel>/`.
 */
export function getProjectTargetStateDir(paths: PlatformPaths, target: WorkspaceTarget): string {
  const base = getProjectStateDir(paths, target.repoRoot);
  if (target.kind === "root") {
    return base;
  }
  return path.join(base, WORKSPACES_DIR, ...splitWorkspacePath(target.relativeDir));
}

/**
 * Workspace-aware variant of {@link getProjectStatePath}.
 */
export function getProjectTargetStatePath(
  paths: PlatformPaths,
  target: WorkspaceTarget,
  ...segments: string[]
): string {
  return path.join(getProjectTargetStateDir(paths, target), ...segments);
}
