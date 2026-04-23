export interface UltraPlanBatchSupervisorWorktreeState {
  headAttached: boolean;
  branchName: string | null;
  dirtyTracked: boolean;
  inProgressOperation: boolean;
  headSha: string;
}

export interface UltraPlanBatchMergeDeps {
  inspectSupervisorWorktree(): UltraPlanBatchSupervisorWorktreeState;
  mergeBranch(branchName: string):
    | { ok: true; newBaseHead: string }
    | { ok: false; summary: string };
  cleanupWorktree(worktreePath: string):
    | { ok: true }
    | { ok: false; summary: string };
}

export interface UltraPlanBatchMergeInput {
  supervisorBranch: string;
  currentBaseHead: string;
  branchName: string;
  worktreePath: string;
  deps: UltraPlanBatchMergeDeps;
}

export type UltraPlanBatchMergeResult =
  | {
      kind: "merged";
      currentBaseHead: string;
      worktreePath: string | null;
      cleanupWarning: string | null;
      countsAgainstParallelism: false;
    }
  | {
      kind: "blocked";
      code: "base-drift" | "project-identity-failed" | "supervisor-worktree-invalid" | "merge-blocked";
      currentBaseHead: string;
      worktreePath: string;
      summary: string;
      countsAgainstParallelism: false;
    };

function block(
  code: Extract<UltraPlanBatchMergeResult, { kind: "blocked" }>["code"],
  input: UltraPlanBatchMergeInput,
  summary: string,
): UltraPlanBatchMergeResult {
  return {
    kind: "blocked",
    code,
    currentBaseHead: input.currentBaseHead,
    worktreePath: input.worktreePath,
    summary,
    countsAgainstParallelism: false,
  };
}

export function mergeUltraPlanBatchWorktree(input: UltraPlanBatchMergeInput): UltraPlanBatchMergeResult {
  const supervisor = input.deps.inspectSupervisorWorktree();
  if (!supervisor.headAttached) {
    return block("supervisor-worktree-invalid", input, "Supervisor worktree HEAD is detached.");
  }
  if (supervisor.branchName !== input.supervisorBranch) {
    return block(
      "supervisor-worktree-invalid",
      input,
      `Supervisor worktree is on ${supervisor.branchName ?? "<unknown>"}, expected ${input.supervisorBranch}.`,
    );
  }
  if (supervisor.dirtyTracked) {
    return block("supervisor-worktree-invalid", input, "Supervisor worktree has tracked changes.");
  }
  if (supervisor.inProgressOperation) {
    return block("supervisor-worktree-invalid", input, "Supervisor worktree has an in-progress git operation.");
  }
  if (supervisor.headSha !== input.currentBaseHead) {
    return block(
      "base-drift",
      input,
      `Supervisor branch advanced from ${input.currentBaseHead} to ${supervisor.headSha} before merge.`,
    );
  }

  const merge = input.deps.mergeBranch(input.branchName);
  if (!merge.ok) {
    return block("merge-blocked", input, merge.summary);
  }

  const cleanup = input.deps.cleanupWorktree(input.worktreePath);
  return {
    kind: "merged",
    currentBaseHead: merge.newBaseHead,
    worktreePath: cleanup.ok ? null : input.worktreePath,
    cleanupWarning: cleanup.ok ? null : cleanup.summary,
    countsAgainstParallelism: false,
  };
}
