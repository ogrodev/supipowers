import type { WorkspaceTarget } from "../types.js";
import { ROOT_WORKSPACE_RELATIVE_DIR, normalizeWorkspaceRelativePath } from "./targets.js";

export function normalizeRepoPath(value: string): string {
  return normalizeWorkspaceRelativePath(value);
}

export function findWorkspaceTargetForPath<TTarget extends WorkspaceTarget>(
  targets: TTarget[],
  repoRelativePath: string,
): TTarget | null {
  const normalizedPath = normalizeRepoPath(repoRelativePath);
  let bestMatch: TTarget | null = null;
  let bestSpecificity = -1;

  for (const target of targets) {
    const scope = normalizeRepoPath(target.relativeDir);
    const isMatch = scope === ROOT_WORKSPACE_RELATIVE_DIR
      ? true
      : normalizedPath === scope || normalizedPath.startsWith(`${scope}/`);

    if (!isMatch) {
      continue;
    }

    const specificity = scope === ROOT_WORKSPACE_RELATIVE_DIR ? 0 : scope.length;
    if (specificity > bestSpecificity) {
      bestMatch = target;
      bestSpecificity = specificity;
    }
  }

  return bestMatch;
}

export function filterPathsForWorkspaceTarget<TTarget extends WorkspaceTarget>(
  targets: TTarget[],
  target: TTarget,
  repoRelativePaths: string[],
): string[] {
  return repoRelativePaths.filter((repoRelativePath) =>
    findWorkspaceTargetForPath(targets, repoRelativePath)?.id === target.id,
  );
}

export function partitionPathsByWorkspaceTarget<TTarget extends WorkspaceTarget>(
  targets: TTarget[],
  repoRelativePaths: string[],
): Map<string, string[]> {
  const partitions = new Map<string, string[]>();

  for (const repoRelativePath of repoRelativePaths) {
    const owner = findWorkspaceTargetForPath(targets, repoRelativePath);
    if (!owner) {
      continue;
    }

    const existing = partitions.get(owner.id);
    if (existing) {
      existing.push(repoRelativePath);
    } else {
      partitions.set(owner.id, [repoRelativePath]);
    }
  }

  return partitions;
}

export function getChangedWorkspaceTargets<TTarget extends WorkspaceTarget>(
  targets: TTarget[],
  repoRelativePaths: string[],
): TTarget[] {
  const changedIds = new Set(partitionPathsByWorkspaceTarget(targets, repoRelativePaths).keys());
  return targets.filter((target) => changedIds.has(target.id));
}
