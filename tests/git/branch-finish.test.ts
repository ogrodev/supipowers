import { describe, test, expect } from "vitest";
import {
  buildBranchFinishPrompt,
  FINISH_OPTIONS,
} from "../../src/git/branch-finish.js";

describe("FINISH_OPTIONS", () => {
  test("has exactly 4 options", () => {
    expect(FINISH_OPTIONS).toHaveLength(4);
  });

  test("includes merge locally", () => {
    expect(FINISH_OPTIONS.some((o) => o.id === "merge")).toBe(true);
  });

  test("includes push and create PR", () => {
    expect(FINISH_OPTIONS.some((o) => o.id === "pr")).toBe(true);
  });

  test("includes keep as-is", () => {
    expect(FINISH_OPTIONS.some((o) => o.id === "keep")).toBe(true);
  });

  test("includes discard", () => {
    expect(FINISH_OPTIONS.some((o) => o.id === "discard")).toBe(true);
  });
});

describe("buildBranchFinishPrompt", () => {
  test("includes branch name", () => {
    const prompt = buildBranchFinishPrompt({
      branchName: "feature/auth",
      baseBranch: "main",
    });
    expect(prompt).toContain("feature/auth");
  });

  test("includes base branch", () => {
    const prompt = buildBranchFinishPrompt({
      branchName: "feature/auth",
      baseBranch: "main",
    });
    expect(prompt).toContain("main");
  });

  test("includes test verification requirement", () => {
    const prompt = buildBranchFinishPrompt({
      branchName: "feature/auth",
      baseBranch: "main",
    });
    expect(prompt).toContain("test");
    expect(prompt).toContain("pass");
  });

  test("includes all 4 options", () => {
    const prompt = buildBranchFinishPrompt({
      branchName: "feature/auth",
      baseBranch: "main",
    });
    expect(prompt).toContain("Merge");
    expect(prompt).toContain("Pull Request");
    expect(prompt).toContain("Keep");
    expect(prompt).toContain("Discard");
  });

  test("includes discard confirmation requirement", () => {
    const prompt = buildBranchFinishPrompt({
      branchName: "feature/auth",
      baseBranch: "main",
    });
    expect(prompt).toContain("confirm");
  });

  test("includes worktree cleanup guidance", () => {
    const prompt = buildBranchFinishPrompt({
      branchName: "feature/auth",
      baseBranch: "main",
      worktreePath: "/project/.worktrees/auth",
    });
    expect(prompt).toContain("worktree");
    expect(prompt).toContain("git worktree remove");
  });

  test("skips worktree cleanup when no worktree path", () => {
    const prompt = buildBranchFinishPrompt({
      branchName: "feature/auth",
      baseBranch: "main",
    });
    expect(prompt).not.toContain("git worktree remove");
  });

  test("includes PR creation with gh command", () => {
    const prompt = buildBranchFinishPrompt({
      branchName: "feature/auth",
      baseBranch: "main",
    });
    expect(prompt).toContain("gh pr create");
  });
});
