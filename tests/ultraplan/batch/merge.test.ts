import { describe, expect, test } from "bun:test";
import {
  mergeUltraPlanBatchWorktree,
  type UltraPlanBatchMergeDeps,
} from "../../../src/ultraplan/batch/merge.js";

function makeDeps(overrides: Partial<UltraPlanBatchMergeDeps> = {}): UltraPlanBatchMergeDeps {
  return {
    inspectSupervisorWorktree: () => ({
      headAttached: true,
      branchName: "main",
      dirtyTracked: false,
      inProgressOperation: false,
      headSha: "sha-base",
    }),
    mergeBranch: () => ({ ok: true, newBaseHead: "sha-merged" }),
    cleanupWorktree: () => ({ ok: true }),
    ...overrides,
  };
}

describe("ultraplan batch merge manager", () => {
  test("merges cleanly and advances currentBaseHead", () => {
    const worktreePath = "/repo/.worktrees/batch-123-up-456";

    const first = mergeUltraPlanBatchWorktree({
      supervisorBranch: "main",
      currentBaseHead: "sha-base",
      branchName: "ultraplan/batch-123/up-456",
      worktreePath,
      deps: makeDeps({ mergeBranch: () => ({ ok: true, newBaseHead: "sha-merged-1" }) }),
    });
    expect(first).toEqual({
      kind: "merged",
      currentBaseHead: "sha-merged-1",
      worktreePath: null,
      cleanupWarning: null,
      countsAgainstParallelism: false,
    });

    const second = mergeUltraPlanBatchWorktree({
      supervisorBranch: "main",
      currentBaseHead: first.currentBaseHead,
      branchName: "ultraplan/batch-123/up-789",
      worktreePath,
      deps: makeDeps({
        inspectSupervisorWorktree: () => ({
          headAttached: true,
          branchName: "main",
          dirtyTracked: false,
          inProgressOperation: false,
          headSha: first.currentBaseHead,
        }),
        mergeBranch: () => ({ ok: true, newBaseHead: "sha-merged-2" }),
      }),
    });
    expect(second.currentBaseHead).toBe("sha-merged-2");
    expect(second.countsAgainstParallelism).toBe(false);
  });

  test("blocks before merge when the supervisor base has drifted", () => {
    const result = mergeUltraPlanBatchWorktree({
      supervisorBranch: "main",
      currentBaseHead: "sha-expected",
      branchName: "ultraplan/batch-123/up-456",
      worktreePath: "/repo/.worktrees/batch-123-up-456",
      deps: makeDeps({
        inspectSupervisorWorktree: () => ({
          headAttached: true,
          branchName: "main",
          dirtyTracked: false,
          inProgressOperation: false,
          headSha: "sha-drifted",
        }),
      }),
    });

    expect(result).toEqual({
      kind: "blocked",
      code: "base-drift",
      currentBaseHead: "sha-expected",
      worktreePath: "/repo/.worktrees/batch-123-up-456",
      summary: "Supervisor branch advanced from sha-expected to sha-drifted before merge.",
      countsAgainstParallelism: false,
    });
  });

  test("rejects invalid supervisor worktree states before attempting merge", () => {
    const invalidStates = [
      {
        inspectSupervisorWorktree: () => ({
          headAttached: false,
          branchName: "main",
          dirtyTracked: false,
          inProgressOperation: false,
          headSha: "sha-base",
        }),
      },
      {
        inspectSupervisorWorktree: () => ({
          headAttached: true,
          branchName: "feature/not-main",
          dirtyTracked: false,
          inProgressOperation: false,
          headSha: "sha-base",
        }),
      },
      {
        inspectSupervisorWorktree: () => ({
          headAttached: true,
          branchName: "main",
          dirtyTracked: true,
          inProgressOperation: false,
          headSha: "sha-base",
        }),
      },
      {
        inspectSupervisorWorktree: () => ({
          headAttached: true,
          branchName: "main",
          dirtyTracked: false,
          inProgressOperation: true,
          headSha: "sha-base",
        }),
      },
    ];

    for (const deps of invalidStates) {
      const result = mergeUltraPlanBatchWorktree({
        supervisorBranch: "main",
        currentBaseHead: "sha-base",
        branchName: "ultraplan/batch-123/up-456",
        worktreePath: "/repo/.worktrees/batch-123-up-456",
        deps: makeDeps(deps),
      });

      expect(result.kind).toBe("blocked");
      if (result.kind === "blocked") {
        expect(result.code).toBe("supervisor-worktree-invalid");
        expect(result.countsAgainstParallelism).toBe(false);
      }
    }
  });

  test("classifies merge conflicts as merge-blocked", () => {
    const result = mergeUltraPlanBatchWorktree({
      supervisorBranch: "main",
      currentBaseHead: "sha-base",
      branchName: "ultraplan/batch-123/up-456",
      worktreePath: "/repo/.worktrees/batch-123-up-456",
      deps: makeDeps({ mergeBranch: () => ({ ok: false, summary: "Manual merge required" }) }),
    });

    expect(result).toEqual({
      kind: "blocked",
      code: "merge-blocked",
      currentBaseHead: "sha-base",
      worktreePath: "/repo/.worktrees/batch-123-up-456",
      summary: "Manual merge required",
      countsAgainstParallelism: false,
    });
  });

  test("preserves a merged result when cleanup fails", () => {
    const worktreePath = "/repo/.worktrees/batch-123-up-456";
    const result = mergeUltraPlanBatchWorktree({
      supervisorBranch: "main",
      currentBaseHead: "sha-base",
      branchName: "ultraplan/batch-123/up-456",
      worktreePath,
      deps: makeDeps({
        mergeBranch: () => ({ ok: true, newBaseHead: "sha-merged" }),
        cleanupWorktree: () => ({ ok: false, summary: "Unable to remove worktree directory" }),
      }),
    });

    expect(result).toEqual({
      kind: "merged",
      currentBaseHead: "sha-merged",
      worktreePath,
      cleanupWarning: "Unable to remove worktree directory",
      countsAgainstParallelism: false,
    });
  });
});
