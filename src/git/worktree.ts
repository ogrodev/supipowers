import { assertSafeRef } from "./sanitize.js";
import * as fs from "node:fs";
import * as path from "node:path";

export interface ProjectSetup {
  type: "node" | "rust" | "python" | "go" | "unknown";
  installCommand: string | null;
  testCommand: string | null;
}

/**
 * Detect existing worktree directory following priority:
 * .worktrees > worktrees > null
 */
export function detectWorktreeDir(cwd: string): string | null {
  const dotWorktrees = path.join(cwd, ".worktrees");
  if (fs.existsSync(dotWorktrees)) return dotWorktrees;

  const worktrees = path.join(cwd, "worktrees");
  if (fs.existsSync(worktrees)) return worktrees;

  return null;
}

/**
 * Auto-detect project type and setup commands from project files.
 */
export function detectProjectSetup(cwd: string): ProjectSetup {
  // Bun (check before generic package.json since Bun projects also have package.json)
  if (fs.existsSync(path.join(cwd, "bun.lock")) || fs.existsSync(path.join(cwd, "bun.lockb"))) {
    return { type: "node", installCommand: "bun install", testCommand: "bun test" };
  }
  if (fs.existsSync(path.join(cwd, "package.json"))) {
    return {
      type: "node",
      installCommand: "npm install",
      testCommand: "npm test",
    };
  }
  if (fs.existsSync(path.join(cwd, "Cargo.toml"))) {
    return {
      type: "rust",
      installCommand: "cargo build",
      testCommand: "cargo test",
    };
  }
  if (fs.existsSync(path.join(cwd, "pyproject.toml"))) {
    return {
      type: "python",
      installCommand: "poetry install",
      testCommand: "pytest",
    };
  }
  if (fs.existsSync(path.join(cwd, "requirements.txt"))) {
    return {
      type: "python",
      installCommand: "pip install -r requirements.txt",
      testCommand: "pytest",
    };
  }
  if (fs.existsSync(path.join(cwd, "go.mod"))) {
    return {
      type: "go",
      installCommand: "go mod download",
      testCommand: "go test ./...",
    };
  }
  return { type: "unknown", installCommand: null, testCommand: null };
}

export interface WorktreePromptOptions {
  branchName: string;
  cwd: string;
}

/**
 * Build the prompt that guides the agent through creating an isolated git worktree.
 * Follows supipowers' using-git-worktrees skill:
 * - Smart directory selection (.worktrees > worktrees > ask)
 * - .gitignore verification
 * - Project setup detection
 * - Baseline test verification
 */
export function buildWorktreePrompt(options: WorktreePromptOptions): string {
  const { branchName, cwd } = options;
  assertSafeRef(branchName, "branchName");

  return [
    "## Set Up Isolated Worktree",
    "",
    `Create an isolated workspace for branch \`${branchName}\`.`,
    "",
    "### Step 1: Select directory",
    "",
    "Check in priority order:",
    `1. \`${cwd}/.worktrees/\` — if it exists, use it`,
    `2. \`${cwd}/worktrees/\` — if it exists, use it`,
    "3. Check CLAUDE.md for worktree directory preference",
    "4. If none found, ask the user:",
    "   - `.worktrees/` (project-local, hidden)",
    "   - `~/.config/supipowers/worktrees/<project>/` (global location)",
    "",
    "### Step 2: Verify gitignore",
    "",
    "For project-local directories, verify the directory is ignored:",
    "",
    "```bash",
    "git check-ignore -q .worktrees 2>/dev/null || git check-ignore -q worktrees 2>/dev/null",
    "```",
    "",
    "If NOT ignored, add it to .gitignore and commit before proceeding.",
    "",
    "### Step 3: Create worktree",
    "",
    "```bash",
    `git worktree add <dir>/${branchName} -b ${branchName}`,
    `cd <dir>/${branchName}`,
    "```",
    "",
    "### Step 4: Project setup",
    "",
    "Auto-detect and run appropriate setup:",
    "",
    "| File | Command |",
    "|------|---------|",
    "| `bun.lock` / `bun.lockb` | `bun install` |",
    "| `package.json` | `npm install` |",
    "| `Cargo.toml` | `cargo build` |",
    "| `pyproject.toml` | `poetry install` |",
    "| `requirements.txt` | `pip install -r requirements.txt` |",
    "| `go.mod` | `go mod download` |",
    "",
    "### Step 5: Verify baseline",
    "",
    "Run the test suite to verify a clean baseline before starting work.",
    "If tests fail, report failures and ask whether to proceed or investigate.",
    "",
    "### Step 6: Report",
    "",
    "```",
    "Worktree ready at <full-path>",
    "Tests passing (<N> tests, 0 failures)",
    `Ready to implement ${branchName}`,
    "```",
  ].join("\n");
}
