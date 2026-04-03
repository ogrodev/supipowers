type ExecFn = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<{ stdout: string; code: number }>;

export interface WorkingTreeStatus {
  dirty: boolean;
  /** Files with uncommitted changes (staged + unstaged + untracked) */
  files: string[];
}

/**
 * Check whether the working tree has uncommitted changes.
 * Returns dirty: false on non-git dirs or exec errors — don't block the caller.
 */
export async function getWorkingTreeStatus(exec: ExecFn, cwd: string): Promise<WorkingTreeStatus> {
  try {
    const result = await exec("git", ["status", "--porcelain"], { cwd });
    if (result.code !== 0) {
      return { dirty: false, files: [] };
    }
    const files = result.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3)); // strip 2-char status + space
    return { dirty: files.length > 0, files };
  } catch {
    return { dirty: false, files: [] };
  }
}
