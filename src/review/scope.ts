import type { Platform, PlatformContext } from "../platform/types.js";
import type { ReviewScope, ReviewScopeFile, ReviewScopeStats, WorkspaceTarget } from "../types.js";
import { filterGitLogOnelineToWorkspaceTarget } from "../workspace/git-scope.js";
import { findWorkspaceTargetForPath } from "../workspace/path-mapping.js";

interface ExcludedReviewScopeFile {
  path: string;
  reason: string;
  additions: number;
  deletions: number;
}

export interface ParsedReviewDiff {
  files: ReviewScopeFile[];
  excluded: ExcludedReviewScopeFile[];
  stats: ReviewScopeStats;
}

export interface ReviewWorkspaceSelection {
  target: WorkspaceTarget;
  targets: WorkspaceTarget[];
}

export const EXCLUDED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\.lock$/, reason: "lock file" },
  { pattern: /-lock\.(json|yaml|yml)$/, reason: "lock file" },
  { pattern: /package-lock\.json$/, reason: "lock file" },
  { pattern: /yarn\.lock$/, reason: "lock file" },
  { pattern: /pnpm-lock\.yaml$/, reason: "lock file" },
  { pattern: /Cargo\.lock$/, reason: "lock file" },
  { pattern: /Gemfile\.lock$/, reason: "lock file" },
  { pattern: /poetry\.lock$/, reason: "lock file" },
  { pattern: /composer\.lock$/, reason: "lock file" },
  { pattern: /flake\.lock$/, reason: "lock file" },
  { pattern: /\.min\.(js|css)$/, reason: "minified" },
  { pattern: /\.generated\./, reason: "generated" },
  { pattern: /\.snap$/, reason: "snapshot" },
  { pattern: /\.map$/, reason: "source map" },
  { pattern: /^dist\//, reason: "build output" },
  { pattern: /^build\//, reason: "build output" },
  { pattern: /^out\//, reason: "build output" },
  { pattern: /node_modules\//, reason: "vendor" },
  { pattern: /vendor\//, reason: "vendor" },
  { pattern: /\.(png|jpg|jpeg|gif|ico|webp|avif)$/i, reason: "image" },
  { pattern: /\.(woff|woff2|ttf|eot|otf)$/i, reason: "font" },
  { pattern: /\.(pdf|zip|tar|gz|rar|7z)$/i, reason: "binary" },
];

function getExclusionReason(filePath: string): string | undefined {
  for (const { pattern, reason } of EXCLUDED_PATTERNS) {
    if (pattern.test(filePath)) {
      return reason;
    }
  }

  return undefined;
}

function buildEmptyStats(): ReviewScopeStats {
  return {
    filesChanged: 0,
    excludedFiles: 0,
    additions: 0,
    deletions: 0,
  };
}

export function parseReviewDiff(diffOutput: string): ParsedReviewDiff {
  if (!diffOutput.trim()) {
    return {
      files: [],
      excluded: [],
      stats: buildEmptyStats(),
    };
  }

  const files: ReviewScopeFile[] = [];
  const excluded: ExcludedReviewScopeFile[] = [];
  let additions = 0;
  let deletions = 0;

  const chunks = diffOutput.split(/^diff --git /m).filter(Boolean);
  for (const chunk of chunks) {
    const headerMatch = chunk.match(/^a\/(.+?) b\/(.+)/);
    if (!headerMatch) {
      continue;
    }

    const filePath = headerMatch[2];
    let fileAdditions = 0;
    let fileDeletions = 0;

    for (const line of chunk.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        fileAdditions += 1;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        fileDeletions += 1;
      }
    }

    const reason = getExclusionReason(filePath);
    if (reason) {
      excluded.push({
        path: filePath,
        reason,
        additions: fileAdditions,
        deletions: fileDeletions,
      });
      continue;
    }

    files.push({
      path: filePath,
      additions: fileAdditions,
      deletions: fileDeletions,
      diff: `diff --git ${chunk}`,
    });
    additions += fileAdditions;
    deletions += fileDeletions;
  }

  return {
    files,
    excluded,
    stats: {
      filesChanged: files.length,
      excludedFiles: excluded.length,
      additions,
      deletions,
    },
  };
}

function createScope(
  mode: ReviewScope["mode"],
  description: string,
  diff: string,
  overrides: Partial<ReviewScope> = {},
): ReviewScope {
  const parsed = parseReviewDiff(diff);
  return {
    mode,
    description,
    diff,
    files: parsed.files,
    stats: parsed.stats,
    ...overrides,
  };
}

async function execGit(
  platform: Pick<Platform, "exec">,
  cwd: string,
  args: string[],
  allowedExitCodes: number[] = [0],
): Promise<string> {
  let result;

  try {
    result = await platform.exec("git", args, { cwd });
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : `git ${args.join(" ")} failed.`);
  }

  if (!allowedExitCodes.includes(result.code)) {
    const detail = result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed with exit code ${result.code}`;
    throw new Error(detail);
  }

  return result.stdout;
}

async function listUntrackedFiles(platform: Pick<Platform, "exec">, cwd: string): Promise<string[]> {
  const output = await execGit(platform, cwd, ["ls-files", "--others", "--exclude-standard"]);
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";

async function buildUntrackedDiff(platform: Pick<Platform, "exec">, cwd: string): Promise<string> {
  const untracked = await listUntrackedFiles(platform, cwd);
  if (untracked.length === 0) {
    return "";
  }

  const diffs = await Promise.all(
    untracked.map((filePath) =>
      execGit(platform, cwd, ["diff", "--no-index", "--", NULL_DEVICE, filePath], [0, 1]).catch(() => ""),
    ),
  );

  return diffs.filter((chunk) => chunk.trim().length > 0).join("\n");
}

function ensureReviewableScope(scope: ReviewScope, message: string): ReviewScope {
  if (!scope.diff.trim()) {
    throw new Error("No diff content found for the selected scope.");
  }

  if (scope.files.length === 0) {
    throw new Error(message);
  }

  return scope;
}

function buildTargetLabel(selection: ReviewWorkspaceSelection): string {
  return `${selection.target.name} (${selection.target.relativeDir})`;
}

function appendTargetContext(description: string, selection?: ReviewWorkspaceSelection | null): string {
  return selection ? `${description} for ${buildTargetLabel(selection)}` : description;
}

function buildEmptyScopeMessage(baseMessage: string, selection?: ReviewWorkspaceSelection | null): string {
  return selection
    ? `${baseMessage} for ${buildTargetLabel(selection)}.`
    : `${baseMessage}.`;
}

function ensureTargetScopeHasDiff(
  diff: string,
  emptyScopeMessage: string,
  selection?: ReviewWorkspaceSelection | null,
): void {
  if (selection && !diff.trim()) {
    throw new Error(emptyScopeMessage);
  }
}

function filterDiffToWorkspaceTarget(diffOutput: string, selection?: ReviewWorkspaceSelection | null): string {
  if (!selection || !diffOutput.trim()) {
    return diffOutput;
  }

  return diffOutput
    .split(/^diff --git /m)
    .filter(Boolean)
    .map((chunk) => `diff --git ${chunk}`)
    .filter((chunk) => {
      const headerMatch = chunk.match(/^diff --git a\/(.+?) b\/(.+)/m);
      const repoRelativePath = headerMatch?.[2]?.trim();
      if (!repoRelativePath) {
        return false;
      }

      return findWorkspaceTargetForPath(selection.targets, repoRelativePath)?.id === selection.target.id;
    })
    .join("\n");
}

export async function listReviewBaseBranches(platform: Pick<Platform, "exec">, cwd: string): Promise<string[]> {
  const output = await execGit(platform, cwd, ["branch", "--all", "--format=%(refname:short)"]);
  return [...new Set(
    output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .filter((line) => !line.endsWith("/HEAD")),
  )].sort();
}

export async function getCurrentReviewBranch(platform: Pick<Platform, "exec">, cwd: string): Promise<string> {
  const branch = (await execGit(platform, cwd, ["branch", "--show-current"])).trim();
  return branch || "HEAD";
}

export async function listRecentReviewCommits(
  platform: Pick<Platform, "exec">,
  cwd: string,
  count = 20,
  selection?: ReviewWorkspaceSelection | null,
): Promise<string[]> {
  if (!selection) {
    const output = await execGit(platform, cwd, ["log", "--oneline", `-${count}`]);
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  const output = await execGit(platform, cwd, ["log", `-${count}`, "--format=%H%x1f%s%x1e", "--name-only"]);
  return filterGitLogOnelineToWorkspaceTarget(output, selection.targets, selection.target)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export async function loadPullRequestScope(
  platform: Pick<Platform, "exec">,
  cwd: string,
  baseBranch: string,
  currentBranch?: string,
  selection?: ReviewWorkspaceSelection | null,
): Promise<ReviewScope> {
  const branch = currentBranch ?? await getCurrentReviewBranch(platform, cwd);
  const rawDiff = await execGit(platform, cwd, ["diff", "--no-ext-diff", "--binary", `${baseBranch}...${branch}`]);
  const diff = filterDiffToWorkspaceTarget(rawDiff, selection);
  ensureTargetScopeHasDiff(
    diff,
    buildEmptyScopeMessage("No reviewable files remain after filtering PR-style changes", selection),
    selection,
  );
  const scope = createScope(
    "pull-request",
    appendTargetContext(`Reviewing changes between ${baseBranch} and ${branch}`, selection),
    diff,
    { baseBranch },
  );
  return ensureReviewableScope(
    scope,
    buildEmptyScopeMessage("No reviewable files remain after filtering PR-style changes", selection),
  );
}

export async function loadUncommittedScope(
  platform: Pick<Platform, "exec">,
  cwd: string,
  selection?: ReviewWorkspaceSelection | null,
): Promise<ReviewScope> {
  const [unstaged, staged, untracked] = await Promise.all([
    execGit(platform, cwd, ["diff", "--no-ext-diff", "--binary"]),
    execGit(platform, cwd, ["diff", "--cached", "--no-ext-diff", "--binary"]),
    buildUntrackedDiff(platform, cwd),
  ]);
  const rawDiff = [unstaged, staged, untracked].filter((chunk) => chunk.trim().length > 0).join("\n");
  const diff = filterDiffToWorkspaceTarget(rawDiff, selection);
  ensureTargetScopeHasDiff(
    diff,
    buildEmptyScopeMessage("No reviewable files remain after filtering uncommitted changes", selection),
    selection,
  );
  const scope = createScope(
    "uncommitted",
    appendTargetContext("Reviewing uncommitted changes", selection),
    diff,
  );
  return ensureReviewableScope(
    scope,
    buildEmptyScopeMessage("No reviewable files remain after filtering uncommitted changes", selection),
  );
}

export async function loadCommitScope(
  platform: Pick<Platform, "exec">,
  cwd: string,
  commit: string,
  selection?: ReviewWorkspaceSelection | null,
): Promise<ReviewScope> {
  const rawDiff = await execGit(platform, cwd, ["show", "--format=", "--no-ext-diff", "--binary", commit]);
  const diff = filterDiffToWorkspaceTarget(rawDiff, selection);
  ensureTargetScopeHasDiff(
    diff,
    buildEmptyScopeMessage("No reviewable files remain after filtering commit changes", selection),
    selection,
  );
  const scope = createScope(
    "commit",
    appendTargetContext(`Reviewing commit ${commit}`, selection),
    diff,
    { commit },
  );
  return ensureReviewableScope(
    scope,
    buildEmptyScopeMessage("No reviewable files remain after filtering commit changes", selection),
  );
}

export async function loadCustomReviewScope(
  platform: Pick<Platform, "exec">,
  cwd: string,
  instructions: string,
  selection?: ReviewWorkspaceSelection | null,
): Promise<ReviewScope> {
  let rawDiff = "";

  try {
    rawDiff = await execGit(platform, cwd, ["diff", "--no-ext-diff", "--binary", "HEAD"]);
  } catch {
    rawDiff = "";
  }

  const diff = filterDiffToWorkspaceTarget(rawDiff, selection);
  ensureTargetScopeHasDiff(
    diff,
    buildEmptyScopeMessage("No reviewable files remain after filtering custom review changes", selection),
    selection,
  );
  const scope = createScope(
    "custom",
    appendTargetContext(`Custom review: ${instructions.slice(0, 60)}`, selection),
    diff,
    { customInstructions: instructions },
  );

  return selection
    ? ensureReviewableScope(
        scope,
        buildEmptyScopeMessage("No reviewable files remain after filtering custom review changes", selection),
      )
    : scope;
}

export async function selectReviewScope(
  platform: Pick<Platform, "exec">,
  ctx: Pick<PlatformContext, "cwd" | "ui">,
  selection?: ReviewWorkspaceSelection | null,
): Promise<ReviewScope | null> {
  const choice = await ctx.ui.select(
    "What should /supi:review inspect?",
    [
      "PR-style — compare current branch against a base branch",
      "Uncommitted changes — staged, unstaged, and untracked",
      "Specific commit — review a recent commit",
      "Custom instructions — describe the review focus",
    ],
    { helpText: "Select the review scope · Esc to cancel" },
  );

  if (!choice) {
    return null;
  }

  if (choice.startsWith("PR-style")) {
    const branches = await listReviewBaseBranches(platform, ctx.cwd);
    if (branches.length === 0) {
      throw new Error("No git branches found.");
    }
    const selected = await ctx.ui.select("Base branch", branches, {
      helpText: "Select the branch to compare against · Esc to cancel",
    });
    if (!selected) {
      return null;
    }
    return loadPullRequestScope(platform, ctx.cwd, selected, undefined, selection);
  }

  if (choice.startsWith("Uncommitted changes")) {
    return loadUncommittedScope(platform, ctx.cwd, selection);
  }

  if (choice.startsWith("Specific commit")) {
    const commits = await listRecentReviewCommits(platform, ctx.cwd, 20, selection);
    if (commits.length === 0) {
      throw new Error(selection
        ? `No commits found for ${buildTargetLabel(selection)}.`
        : "No commits found.");
    }
    const selected = await ctx.ui.select("Commit to review", commits, {
      helpText: "Select a recent commit · Esc to cancel",
    });
    if (!selected) {
      return null;
    }
    const commit = selected.split(" ")[0]?.trim();
    if (!commit) {
      throw new Error("Could not determine the selected commit hash.");
    }
    return loadCommitScope(platform, ctx.cwd, commit, selection);
  }

  const instructions = await ctx.ui.input("Custom review focus", {
    helpText: "Describe what the review should pay special attention to.",
    placeholder: "Example: focus on auth flows, data races, and unsafe error handling",
  });
  if (!instructions?.trim()) {
    return null;
  }
  return loadCustomReviewScope(platform, ctx.cwd, instructions.trim(), selection);
}
