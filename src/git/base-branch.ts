type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string; code: number }>;

const FALLBACK = "main";

/**
 * Detect the repository's default branch.
 * Strategy:
 * 1. git symbolic-ref refs/remotes/origin/HEAD → parse branch name
 * 2. git config init.defaultBranch
 * 3. Falls back to "main"
 */
export async function detectBaseBranch(exec: ExecFn): Promise<string> {
  try {
    const result = await exec("git", ["symbolic-ref", "refs/remotes/origin/HEAD"]);
    if (result.code === 0 && result.stdout.trim()) {
      const ref = result.stdout.trim();
      const branch = ref.replace(/^refs\/remotes\/origin\//, "");
      if (branch && branch !== ref) return branch;
    }
  } catch { /* continue to next strategy */ }

  try {
    const result = await exec("git", ["config", "init.defaultBranch"]);
    if (result.code === 0 && result.stdout.trim()) {
      return result.stdout.trim();
    }
  } catch { /* continue to fallback */ }

  return FALLBACK;
}
