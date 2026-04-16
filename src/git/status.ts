import { normalizeLineEndings } from "../text.js";

type ExecFn = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<{ stdout: string; code: number }>;

export interface WorkingTreeStatus {
  dirty: boolean;
  /** Files with uncommitted changes (staged + unstaged + untracked) */
  files: string[];
  /** Files currently staged in the index. */
  stagedFiles: string[];
  /** Files with unstaged or untracked changes. */
  unstagedFiles: string[];
}

interface ParsedPorcelainEntry {
  path: string;
  staged: boolean;
  unstaged: boolean;
}

function parsePorcelainPath(rawPath: string): string {
  const renameSegments = rawPath.split(" -> ");
  return renameSegments[renameSegments.length - 1]?.trim() ?? rawPath.trim();
}

function parsePorcelainLine(line: string): ParsedPorcelainEntry | null {
  if (line.length < 4) {
    return null;
  }

  const indexStatus = line[0] ?? " ";
  const worktreeStatus = line[1] ?? " ";
  const rawPath = line.slice(3).trim();
  if (!rawPath) {
    return null;
  }

  return {
    path: parsePorcelainPath(rawPath),
    staged: indexStatus !== " " && indexStatus !== "?",
    unstaged: worktreeStatus !== " " || indexStatus === "?",
  };
}

/**
 * Check whether the working tree has uncommitted changes.
 * Returns dirty: false on non-git dirs or exec errors — don't block the caller.
 */
export async function getWorkingTreeStatus(exec: ExecFn, cwd: string): Promise<WorkingTreeStatus> {
  try {
    const result = await exec("git", ["status", "--porcelain"], { cwd });
    if (result.code !== 0) {
      return { dirty: false, files: [], stagedFiles: [], unstagedFiles: [] };
    }

    const files: string[] = [];
    const stagedFiles: string[] = [];
    const unstagedFiles: string[] = [];

    for (const line of normalizeLineEndings(result.stdout).split("\n").filter(Boolean)) {
      const entry = parsePorcelainLine(line);
      if (!entry) {
        continue;
      }

      files.push(entry.path);
      if (entry.staged) {
        stagedFiles.push(entry.path);
      }
      if (entry.unstaged) {
        unstagedFiles.push(entry.path);
      }
    }

    return {
      dirty: files.length > 0,
      files,
      stagedFiles,
      unstagedFiles,
    };
  } catch {
    return { dirty: false, files: [], stagedFiles: [], unstagedFiles: [] };
  }
}
