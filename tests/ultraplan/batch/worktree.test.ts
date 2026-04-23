import { describe, expect, test } from "bun:test";
import {
  buildUltraPlanBatchBranchName,
  prepareUltraPlanBatchWorktree,
  resolveUltraPlanBatchWorktreePath,
  resolveUltraPlanBatchWorktreeRootDir,
} from "../../../src/ultraplan/batch/worktree.js";

describe("ultraplan batch worktree helpers", () => {
  test("builds a deterministic branch name from the run id and session id", () => {
    expect(buildUltraPlanBatchBranchName("batch-123", "up-456")).toBe("ultraplan/batch-123/up-456");
  });

  test("selects .worktrees, then worktrees, then the global fallback root", () => {
    const repoRoot = "/repo";
    const globalWorktreesRoot = "/global/worktrees";

    expect(
      resolveUltraPlanBatchWorktreeRootDir({
        repoRoot,
        globalWorktreesRoot,
        deps: {
          exists: (candidate) => candidate === "/repo/.worktrees",
        },
      }),
    ).toBe("/repo/.worktrees");

    expect(
      resolveUltraPlanBatchWorktreeRootDir({
        repoRoot,
        globalWorktreesRoot,
        deps: {
          exists: (candidate) => candidate === "/repo/worktrees",
        },
      }),
    ).toBe("/repo/worktrees");

    expect(
      resolveUltraPlanBatchWorktreeRootDir({
        repoRoot,
        globalWorktreesRoot,
        deps: {
          exists: () => false,
        },
      }),
    ).toBe("/global/worktrees/repo");
  });

  test("reuses an already prepared matching worktree", () => {
    const repoRoot = "/repo";
    const globalWorktreesRoot = "/global/worktrees";
    const worktreePath = resolveUltraPlanBatchWorktreePath({
      repoRoot,
      runId: "batch-123",
      sessionId: "up-456",
      globalWorktreesRoot,
      deps: { exists: (candidate) => candidate === "/repo/.worktrees" },
    });

    expect(
      prepareUltraPlanBatchWorktree({
        repoRoot,
        runId: "batch-123",
        sessionId: "up-456",
        globalWorktreesRoot,
        deps: {
          exists: (candidate) => candidate === "/repo/.worktrees" || candidate === worktreePath,
          hasGitEntry: (candidate) => candidate === worktreePath,
          readBranchName: () => "ultraplan/batch-123/up-456",
        },
      }),
    ).toEqual({
      kind: "reused",
      branchName: "ultraplan/batch-123/up-456",
      worktreePath,
    });
  });

  test("blocks when an existing worktree path is partial or mismatched", () => {
    const repoRoot = "/repo";
    const globalWorktreesRoot = "/global/worktrees";
    const worktreePath = resolveUltraPlanBatchWorktreePath({
      repoRoot,
      runId: "batch-123",
      sessionId: "up-456",
      globalWorktreesRoot,
      deps: { exists: (candidate) => candidate === "/repo/.worktrees" },
    });

    expect(
      prepareUltraPlanBatchWorktree({
        repoRoot,
        runId: "batch-123",
        sessionId: "up-456",
        globalWorktreesRoot,
        deps: {
          exists: (candidate) => candidate === "/repo/.worktrees" || candidate === worktreePath,
          hasGitEntry: () => false,
          readBranchName: () => null,
        },
      }),
    ).toEqual({
      kind: "blocked",
      code: "partial-state",
      branchName: "ultraplan/batch-123/up-456",
      worktreePath,
      summary: `Existing worktree path ${worktreePath} is missing git metadata.`,
    });

    expect(
      prepareUltraPlanBatchWorktree({
        repoRoot,
        runId: "batch-123",
        sessionId: "up-456",
        globalWorktreesRoot,
        deps: {
          exists: (candidate) => candidate === "/repo/.worktrees" || candidate === worktreePath,
          hasGitEntry: () => true,
          readBranchName: () => "feature/unrelated-branch",
        },
      }),
    ).toEqual({
      kind: "blocked",
      code: "mismatched-state",
      branchName: "ultraplan/batch-123/up-456",
      worktreePath,
      summary: `Existing worktree path ${worktreePath} is bound to feature/unrelated-branch, expected ultraplan/batch-123/up-456.`,
    });
  });
});
