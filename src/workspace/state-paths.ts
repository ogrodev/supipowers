import path from "node:path";
import type { PlatformPaths } from "../platform/types.js";
import type { WorkspaceTarget } from "../types.js";
import { ROOT_WORKSPACE_RELATIVE_DIR, normalizeWorkspaceRelativePath } from "./targets.js";

const WORKSPACES_DIR = "workspaces";

function splitWorkspacePath(relativeDir: string): string[] {
  const normalized = normalizeWorkspaceRelativePath(relativeDir);
  return normalized === ROOT_WORKSPACE_RELATIVE_DIR ? [] : normalized.split("/").filter(Boolean);
}

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


export function getTargetStatePath(
  paths: PlatformPaths,
  target: WorkspaceTarget,
  ...segments: string[]
): string {
  return path.join(getTargetStateDir(paths, target), ...segments);
}
