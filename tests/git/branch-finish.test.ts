
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

  test("throws on unsafe branch name", () => {
    expect(() => buildBranchFinishPrompt({ branchName: "main; rm -rf /", baseBranch: "main" })).toThrow("Unsafe branchName");
  });

  test("throws on unsafe base branch", () => {
    expect(() => buildBranchFinishPrompt({ branchName: "feature/ok", baseBranch: "main$(cmd)" })).toThrow("Unsafe baseBranch");
  });

  test("throws on unsafe worktree path", () => {
    expect(() => buildBranchFinishPrompt({ branchName: "feature/ok", baseBranch: "main", worktreePath: "/path;rm -rf /" })).toThrow("Unsafe worktreePath");
  });

  test("option 4 includes worktree remove when worktreePath provided", () => {
    const prompt = buildBranchFinishPrompt({
      branchName: "feature/auth",
      baseBranch: "main",
      worktreePath: "/project/.worktrees/auth",
    });
    expect(prompt).toContain("git worktree remove /project/.worktrees/auth");
    expect(prompt).toContain("git branch -D feature/auth");
  });

  test("option 4 does not include worktree remove without worktreePath", () => {
    const prompt = buildBranchFinishPrompt({
      branchName: "feature/auth",
      baseBranch: "main",
    });
    const option4Section = prompt.split("Option 4")[1];
    expect(option4Section).toBeDefined();
    expect(option4Section).not.toContain("git worktree remove");
  });
});
