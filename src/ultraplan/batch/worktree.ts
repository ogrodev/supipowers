import * as fs from "node:fs";
import * as path from "node:path";
import { assertSafeRef } from "../../git/sanitize.js";

export interface UltraPlanBatchWorktreeDeps {
  exists(candidate: string): boolean;
  hasGitEntry(worktreePath: string): boolean;
  readBranchName(worktreePath: string): string | null;
}

export interface ResolveUltraPlanBatchWorktreeRootDirInput {
  repoRoot: string;
  globalWorktreesRoot: string;
  deps?: Partial<UltraPlanBatchWorktreeDeps>;
}

export interface ResolveUltraPlanBatchWorktreePathInput extends ResolveUltraPlanBatchWorktreeRootDirInput {
  runId: string;
  sessionId: string;
}

export type UltraPlanBatchWorktreePreparation =
  | { kind: "create"; branchName: string; worktreePath: string }
  | { kind: "reused"; branchName: string; worktreePath: string }
  | { kind: "blocked"; code: "partial-state" | "mismatched-state"; branchName: string; worktreePath: string; summary: string };

function buildDeps(overrides: ResolveUltraPlanBatchWorktreeRootDirInput["deps"]): UltraPlanBatchWorktreeDeps {
  return {
    exists: overrides?.exists ?? ((candidate) => fs.existsSync(candidate)),
    hasGitEntry: overrides?.hasGitEntry ?? ((worktreePath) => fs.existsSync(path.join(worktreePath, ".git"))),
    readBranchName: overrides?.readBranchName ?? (() => null),
  };
}

function pathApiFor(basePath: string): typeof path.posix | typeof path {
  if (basePath.startsWith("/") && !basePath.startsWith("//") && !basePath.includes("\\")) {
    return path.posix;
  }
  return path;
}

function joinLike(basePath: string, ...segments: string[]): string {
  return pathApiFor(basePath).join(basePath, ...segments);
}

function basenameLike(basePath: string): string {
  return pathApiFor(basePath).basename(basePath);
}


export function buildUltraPlanBatchBranchName(runId: string, sessionId: string): string {
  const branchName = `ultraplan/${runId}/${sessionId}`;
  assertSafeRef(branchName, "branchName");
  return branchName;
}

export function resolveUltraPlanBatchWorktreeRootDir(input: ResolveUltraPlanBatchWorktreeRootDirInput): string {
  const deps = buildDeps(input.deps);
  const dotWorktrees = joinLike(input.repoRoot, ".worktrees");
  if (deps.exists(dotWorktrees)) {
    return dotWorktrees;
  }

  const worktrees = joinLike(input.repoRoot, "worktrees");
  if (deps.exists(worktrees)) {
    return worktrees;
  }

  return joinLike(input.globalWorktreesRoot, basenameLike(input.repoRoot));
}

export function resolveUltraPlanBatchWorktreePath(input: ResolveUltraPlanBatchWorktreePathInput): string {
  const rootDir = resolveUltraPlanBatchWorktreeRootDir(input);
  return joinLike(rootDir, `${input.runId}-${input.sessionId}`);
}

export function prepareUltraPlanBatchWorktree(input: ResolveUltraPlanBatchWorktreePathInput): UltraPlanBatchWorktreePreparation {
  const deps = buildDeps(input.deps);
  const branchName = buildUltraPlanBatchBranchName(input.runId, input.sessionId);
  const worktreePath = resolveUltraPlanBatchWorktreePath(input);

  if (!deps.exists(worktreePath)) {
    return { kind: "create", branchName, worktreePath };
  }

  if (!deps.hasGitEntry(worktreePath)) {
    return {
      kind: "blocked",
      code: "partial-state",
      branchName,
      worktreePath,
      summary: `Existing worktree path ${worktreePath} is missing git metadata.`,
    };
  }

  const existingBranchName = deps.readBranchName(worktreePath);
  if (existingBranchName === branchName) {
    return { kind: "reused", branchName, worktreePath };
  }

  return {
    kind: "blocked",
    code: existingBranchName ? "mismatched-state" : "partial-state",
    branchName,
    worktreePath,
    summary: existingBranchName
      ? `Existing worktree path ${worktreePath} is bound to ${existingBranchName}, expected ${branchName}.`
      : `Existing worktree path ${worktreePath} is missing git metadata.`,
  };
}
