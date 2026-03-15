import { assertSafeRef, assertSafePath } from "./sanitize.js";

export interface FinishOption {
  id: "merge" | "pr" | "keep" | "discard";
  label: string;
}

/** The 4 structured options for finishing a branch */
export const FINISH_OPTIONS: FinishOption[] = [
  { id: "merge", label: "Merge back to base branch locally" },
  { id: "pr", label: "Push and create a Pull Request" },
  { id: "keep", label: "Keep the branch as-is (handle later)" },
  { id: "discard", label: "Discard this work" },
];

export interface BranchFinishPromptOptions {
  branchName: string;
  baseBranch: string;
  worktreePath?: string;
}

/**
 * Build the prompt that guides the agent through finishing a development branch.
 * Follows supipowers' finishing-a-development-branch skill:
 * - Verify tests pass first
 * - Present exactly 4 options
 * - Execute chosen option
 * - Clean up worktree (conditional)
 */
export function buildBranchFinishPrompt(
  options: BranchFinishPromptOptions,
): string {
  const { branchName, baseBranch, worktreePath } = options;

  assertSafeRef(branchName, "branchName");
  assertSafeRef(baseBranch, "baseBranch");
  if (worktreePath) assertSafePath(worktreePath, "worktreePath");

  const sections: string[] = [
    "## Finish Development Branch",
    "",
    `Branch: \`${branchName}\` (base: \`${baseBranch}\`)`,
    "",
    "### Step 1: Verify tests pass",
    "",
    "Run the full test suite. All tests must pass before proceeding.",
    "If tests fail, fix them first — do not offer options until green.",
    "",
    "### Step 2: Present options",
    "",
    "Ask the user:",
    "",
    "> Implementation complete. What would you like to do?",
    ">",
    `> 1. Merge back to \`${baseBranch}\` locally`,
    "> 2. Push and create a Pull Request",
    "> 3. Keep the branch as-is (handle later)",
    "> 4. Discard this work",
    "",
    "### Option 1: Merge locally",
    "",
    "```bash",
    `git checkout ${baseBranch}`,
    "git pull",
    `git merge ${branchName}`,
    "# Verify tests pass on merged result",
    `git branch -d ${branchName}`,
    "```",
    "",
    "### Option 2: Push and create Pull Request",
    "",
    "```bash",
    `git push -u origin ${branchName}`,
    `gh pr create --title "<title>" --body "<summary>"`,
    "```",
    "",
    "### Option 3: Keep as-is",
    "",
    `Report: "Keeping branch ${branchName}."`,
    "Do NOT clean up worktree.",
    "",
    "### Option 4: Discard",
    "",
    "**Require explicit confirm before deleting.** Show what will be lost:",
    "",
    "```bash",
    `git checkout ${baseBranch}`,
    ...(worktreePath ? [`git worktree remove ${worktreePath}`] : []),
    `git branch -D ${branchName}`,
    "```",
  ];

  if (worktreePath) {
    sections.push(
      "",
      "### Worktree cleanup",
      "",
      `Worktree at: \`${worktreePath}\``,
      "",
      "- **Option 1:** Clean up the worktree:",
      "  ```bash",
      `  git worktree remove ${worktreePath}`,
      "  ```",
      "- **Option 2:** Keep worktree (PR may need updates)",
      "- **Option 3:** Keep worktree",
    );
  }

  return sections.join("\n");
}
