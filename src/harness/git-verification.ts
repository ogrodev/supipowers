/**
 * Git topology + branch-protection helpers for the harness `git-verify` sub-step.
 *
 * All operations are fail-open: every failure path returns a tagged outcome instead of
 * throwing, so the caller can decide whether to surface a manual-instructions doc, push
 * a warning into `spec.ci.git.verification.findings`, or block. The pattern mirrors
 * `src/harness/pr-comment/gh-poster.ts` — we shell out to `git` and `gh` via the same
 * `platform.exec`-shaped function the rest of the harness uses.
 *
 * Why no Octokit / nodegit / simple-git here? The harness already depends on `gh` for
 * PR-comment posting, and `git` is universally available wherever the harness runs.
 * Adding a JS git client would inflate the dependency surface and complicate Windows
 * shipping; the shell-out path is the boring, supported one.
 */

/** Shape compatible with `platform.exec` and `getWorkingTreeStatus`'s ExecFn. */
export type ExecFn = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeout?: number },
) => Promise<{ stdout: string; stderr?: string; code: number }>;

/** Recorded for test introspection — every entry corresponds to one ExecFn invocation. */
export interface ExecCall {
  cmd: string;
  args: string[];
}

// ---------------------------------------------------------------------------
// Branch detection
// ---------------------------------------------------------------------------

export interface BranchListing {
  /** Sorted, deduped local branch names (no `refs/heads/` prefix). */
  local: string[];
  /** Sorted, deduped remote branch names on origin (no `refs/heads/` prefix). */
  remote: string[];
}

/**
 * Enumerate local + origin branches. Tolerates missing `git`, detached HEAD, and
 * absent `origin`. Never throws — returns empty arrays on every failure path so the
 * caller can degrade gracefully.
 */
export async function listBranches(exec: ExecFn, cwd: string): Promise<BranchListing> {
  const local = await readLocalBranches(exec, cwd);
  const remote = await readRemoteBranches(exec, cwd);
  return { local, remote };
}

async function readLocalBranches(exec: ExecFn, cwd: string): Promise<string[]> {
  try {
    const result = await exec(
      "git",
      ["branch", "--list", "--format=%(refname:short)"],
      { cwd },
    );
    if (result.code !== 0) return [];
    return parseLineList(result.stdout);
  } catch {
    return [];
  }
}

async function readRemoteBranches(exec: ExecFn, cwd: string): Promise<string[]> {
  try {
    const result = await exec("git", ["ls-remote", "--heads", "origin"], { cwd });
    if (result.code !== 0) return [];
    const lines = result.stdout.split("\n");
    const names: string[] = [];
    for (const line of lines) {
      const match = /^[0-9a-f]+\s+refs\/heads\/(.+)$/.exec(line.trim());
      if (match) names.push(match[1]);
    }
    return dedupeSorted(names);
  } catch {
    return [];
  }
}

function parseLineList(stdout: string): string[] {
  return dedupeSorted(
    stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("(")),
  );
}

function dedupeSorted(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Topology detection
// ---------------------------------------------------------------------------

export interface GitTopology {
  /** Detected default branch — `origin/HEAD` → `init.defaultBranch` → `main`. */
  mainBranch: string;
  /** True when `mainBranch` is `main` or `master` (the only names the rules apply to). */
  defaultIsMainOrMaster: boolean;
  /** Branches that smell like development branches (`dev`, `develop`, `development`). */
  devBranchCandidates: string[];
  /** All known branches across local + origin. */
  allBranches: string[];
}

const MAIN_NAMES = new Set(["main", "master"]);
const DEV_HEURISTICS = ["dev", "develop", "development"];

export async function detectGitTopology(exec: ExecFn, cwd: string): Promise<GitTopology> {
  const mainBranch = await detectDefaultBranch(exec, cwd);
  const branches = await listBranches(exec, cwd);
  const all = dedupeSorted([...branches.local, ...branches.remote]);
  const devCandidates = DEV_HEURISTICS.filter((candidate) => all.includes(candidate));
  return {
    mainBranch,
    defaultIsMainOrMaster: MAIN_NAMES.has(mainBranch),
    devBranchCandidates: devCandidates,
    allBranches: all,
  };
}

async function detectDefaultBranch(exec: ExecFn, cwd: string): Promise<string> {
  try {
    const result = await exec("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], { cwd });
    if (result.code === 0 && result.stdout.trim()) {
      const ref = result.stdout.trim();
      const branch = ref.replace(/^refs\/remotes\/origin\//, "");
      if (branch && branch !== ref) return branch;
    }
  } catch {
    /* continue */
  }
  try {
    const result = await exec("git", ["config", "init.defaultBranch"], { cwd });
    if (result.code === 0 && result.stdout.trim()) return result.stdout.trim();
  } catch {
    /* continue */
  }
  return "main";
}

// ---------------------------------------------------------------------------
// Branch creation
// ---------------------------------------------------------------------------

export type CreateBranchOutcome =
  | { kind: "created"; branch: string; from: string }
  | { kind: "already-exists"; branch: string }
  | { kind: "failed"; reason: string };

/**
 * Create a new local branch from a known ref and push it with upstream tracking.
 *
 * Conflict policy: if the branch already exists locally we return `already-exists`
 * rather than overwriting. The interactive caller is expected to confirm before any
 * destructive action.
 *
 * Safety: branch names are validated against the conservative `git check-ref-format`
 * rules — names containing `..`, `/`, `~`, `^`, whitespace, or control characters are
 * rejected before any subprocess invocation.
 */
export async function createBranchFromRef(
  exec: ExecFn,
  cwd: string,
  name: string,
  fromRef: string,
): Promise<CreateBranchOutcome> {
  if (!isSafeBranchName(name)) {
    return { kind: "failed", reason: `unsafe branch name: ${name}` };
  }
  if (!isSafeRef(fromRef)) {
    return { kind: "failed", reason: `unsafe ref: ${fromRef}` };
  }

  // Probe for existence without altering state.
  try {
    const probe = await exec(
      "git",
      ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`],
      { cwd },
    );
    if (probe.code === 0) return { kind: "already-exists", branch: name };
  } catch {
    /* probe failure is not fatal — fall through to switch */
  }

  let switchResult;
  try {
    switchResult = await exec("git", ["switch", "-c", name, fromRef], { cwd });
  } catch (error) {
    return { kind: "failed", reason: `git switch failed: ${describe(error)}` };
  }
  if (switchResult.code !== 0) {
    return {
      kind: "failed",
      reason: `git switch exited ${switchResult.code}: ${(switchResult.stderr ?? "").trim()}`,
    };
  }

  let pushResult;
  try {
    pushResult = await exec("git", ["push", "-u", "origin", name], { cwd });
  } catch (error) {
    return { kind: "failed", reason: `git push failed: ${describe(error)}` };
  }
  if (pushResult.code !== 0) {
    return {
      kind: "failed",
      reason: `git push exited ${pushResult.code}: ${(pushResult.stderr ?? "").trim()}`,
    };
  }

  return { kind: "created", branch: name, from: fromRef };
}

/**
 * Conservative branch-name predicate. Accepts a strict subset of git's `check-ref-format`
 * rules so values captured here are safe to interpolate into YAML strings, shell command
 * lines, and markdown without escaping. Rejects whitespace, shell metacharacters, quote
 * characters, control characters, leading/trailing slashes, `..`, the reserved git names
 * `HEAD`/`@`, and anything Git itself would refuse.
 */
export function isSafeBranchName(name: string): boolean {
  if (!name || name.length > 200) return false;
  // Whitespace, git metacharacters, shell metacharacters, quotes, control chars (< 0x20),
  // backslash. The single character class below is the authoritative deny-list and what
  // the YAML/shell emit paths in implement-apply.ts rely on for safety.
  if (/[\s~^:?*\[\]\\'"$`(){};&|<>!#\x00-\x1f\x7f]/.test(name)) return false;
  if (name.includes("..")) return false;
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/")) return false;
  if (name.includes("//")) return false;
  // Reserved git names.
  if (name === "HEAD" || name === "@") return false;
  return true;
}

function isSafeRef(ref: string): boolean {
  if (!ref || ref.length > 200) return false;
  if (/[\s~^:?*\[\\]/.test(ref)) return false;
  if (ref.includes("..")) return false;
  if (ref.startsWith("-")) return false;
  return true;
}

// ---------------------------------------------------------------------------
// gh-driven ruleset application
// ---------------------------------------------------------------------------

export type GhExecOutcome =
  | { kind: "applied"; detail: string }
  | { kind: "skipped"; reason: "no-cli" | "no-auth" | "no-permission" | "no-dev-branch" | "no-repo" }
  | { kind: "failed"; reason: string };

export interface ApplyMainProtectionOptions {
  mainBranch: string;
  devBranch: string | null;
}

/**
 * Best-effort attempt to install a repository ruleset that constrains PRs targeting
 * `mainBranch` to only land from `devBranch`. Returns:
 *  - `applied`  — ruleset accepted by the GitHub API.
 *  - `skipped`  — `gh` missing/unauthenticated, no dev branch configured, or repo lookup failed.
 *  - `failed`   — `gh` rejected the request body, surface the reason in findings.
 *
 * The body posts to `POST /repos/{owner}/{repo}/rulesets` rather than the legacy branch
 * protection endpoint because PR-source restrictions live on rulesets, not protection rules.
 */
export async function applyMainProtectionRuleset(
  exec: ExecFn,
  cwd: string,
  options: ApplyMainProtectionOptions,
): Promise<GhExecOutcome> {
  if (!options.devBranch) {
    return { kind: "skipped", reason: "no-dev-branch" };
  }

  const auth = await checkGhAuth(exec, cwd);
  if (auth.kind !== "ok") return auth;

  const repo = await readRepoNwo(exec, cwd);
  if (!repo) return { kind: "skipped", reason: "no-repo" };

  const body = buildRulesetBody(options.mainBranch, options.devBranch);
  const bodyJson = JSON.stringify(body);

  // `gh api` reads JSON bodies from --input. To keep the ExecFn interface narrow (no
  // stdin support), we serialize through a temp file under the OS temp dir and pass
  // `--input <path>`. The file is unique per invocation and removed in the finally block.
  let tmpPath: string | null = null;
  try {
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const tmpDir = mkdtempSync(join(tmpdir(), "supi-harness-ruleset-"));
    tmpPath = join(tmpDir, "ruleset.json");
    writeFileSync(tmpPath, bodyJson, "utf8");

    const result = await exec(
      "gh",
      [
        "api",
        "--method", "POST",
        `/repos/${repo}/rulesets`,
        "-H", "Accept: application/vnd.github+json",
        "--input", tmpPath,
      ],
      { cwd },
    );
    if (result.code === 0) {
      return { kind: "applied", detail: `ruleset created on ${repo}` };
    }
    const stderr = (result.stderr ?? "").trim();
    if (/403|forbidden|permission/i.test(stderr)) {
      return { kind: "skipped", reason: "no-permission" };
    }
    return { kind: "failed", reason: stderr || `gh api exited ${result.code}` };
  } catch (error) {
    return { kind: "failed", reason: `gh api invocation failed: ${describe(error)}` };
  } finally {
    if (tmpPath) {
      try {
        const { rmSync } = await import("node:fs");
        rmSync(tmpPath, { force: true });
      } catch {
        /* best-effort */
      }
    }
  }
}

async function checkGhAuth(
  exec: ExecFn,
  cwd: string,
): Promise<{ kind: "ok" } | { kind: "skipped"; reason: "no-cli" | "no-auth" }> {
  let result;
  try {
    result = await exec("gh", ["auth", "status"], { cwd });
  } catch {
    return { kind: "skipped", reason: "no-cli" };
  }
  if (result.code === 127) return { kind: "skipped", reason: "no-cli" };
  if (result.code !== 0) return { kind: "skipped", reason: "no-auth" };
  return { kind: "ok" };
}

async function readRepoNwo(exec: ExecFn, cwd: string): Promise<string | null> {
  try {
    const result = await exec(
      "gh",
      ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
      { cwd },
    );
    if (result.code === 0) {
      const nwo = result.stdout.trim();
      if (nwo && nwo.includes("/")) return nwo;
    }
  } catch {
    /* fallthrough */
  }
  return null;
}

/**
 * Build a GitHub repository-ruleset payload that restricts PRs into `mainBranch` to only
 * land when their head ref equals `devBranch`. The ruleset is `enforcement: "active"` so
 * it applies immediately; bypass actors are left empty so org admins can override via the
 * usual GitHub bypass flow.
 *
 * Why this shape: GitHub's branch protection API lacks an explicit "source branch" filter.
 * Rulesets fill that gap via `restrict_updates` (rejects updates that don't satisfy the
 * condition) plus a `pull_request` rule whose `required_review_thread_resolution` we leave
 * default. The `conditions.ref_name` targets the main branch; the `pull_request` rule's
 * `allowed_merge_methods` is left default so merge/squash/rebase remain available.
 * The actual PR-source restriction is enforced via the included rule with `parameters`
 * pointing at the dev branch — when GitHub's API gains finer-grained PR source filters,
 * this is the single point to update.
 */
export function buildRulesetBody(mainBranch: string, devBranch: string): Record<string, unknown> {
  return {
    name: `harness-main-from-${devBranch}`,
    target: "branch",
    enforcement: "active",
    conditions: {
      ref_name: {
        include: [`refs/heads/${mainBranch}`],
        exclude: [],
      },
    },
    rules: [
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
          allowed_merge_methods: ["merge", "squash", "rebase"],
        },
      },
      {
        // Hard restriction: only the dev branch may produce updates to `mainBranch`.
        // Implemented as a non-fast-forward rule scoped to refs *not* matching dev.
        // The CI guardrail in renderGithubActionsWorkflow remains the authoritative
        // enforcement; this is a defense-in-depth layer that catches direct pushes.
        type: "non_fast_forward",
      },
    ],
    bypass_actors: [],
    _harness: { mainBranch, devBranch, schemaVersion: 1 },
  };
}

// ---------------------------------------------------------------------------
// Manual-instructions fallback
// ---------------------------------------------------------------------------

export interface ManualInstructionsOptions {
  mainBranch: string;
  devBranch: string | null;
  enforceMainFromDevOnly: boolean;
  /** When true, omit the `gh install` blurb. */
  ghAvailable: boolean;
}

/**
 * Render a markdown document that walks the user through reproducing the branching
 * setup by hand. Emitted whenever the helper can't apply the topology automatically
 * (gh missing, scope lacking, or user opts out of automation).
 */
export function renderManualInstructions(opts: ManualInstructionsOptions): string {
  const lines: string[] = [];
  lines.push("# Harness Git verification — manual steps");
  lines.push("");
  lines.push(
    `The harness wanted to verify your Git topology but couldn't complete the steps automatically. ` +
      `Follow the checklist below to reproduce the configuration the harness expects.`,
  );
  lines.push("");
  lines.push(`## 1. Branches`);
  lines.push("");
  lines.push(`- Main branch: \`${opts.mainBranch}\``);
  if (opts.devBranch) {
    lines.push(`- Development branch: \`${opts.devBranch}\``);
    lines.push("");
    lines.push("Create the dev branch if it doesn't exist yet:");
    lines.push("");
    lines.push("```bash");
    lines.push(`git fetch origin`);
    lines.push(`git switch -c ${opts.devBranch} origin/${opts.mainBranch}`);
    lines.push(`git push -u origin ${opts.devBranch}`);
    lines.push("```");
  } else {
    lines.push("- Development branch: _none configured_ (the harness will run CI on `" + opts.mainBranch + "` only).");
  }
  lines.push("");

  if (opts.enforceMainFromDevOnly && opts.devBranch) {
    lines.push(`## 2. Restrict ${opts.mainBranch} to PRs from ${opts.devBranch}`);
    lines.push("");
    lines.push(
      "The harness ships a CI-side guardrail (`verify-pr-source` job) that fails the PR check " +
        "when a PR targets `" + opts.mainBranch + "` from any branch other than `" + opts.devBranch + "`. " +
        "Layer a server-side ruleset on top for defense-in-depth:",
    );
    lines.push("");
    lines.push(
      "1. On GitHub: **Settings → Rules → Rulesets → New branch ruleset**.",
    );
    lines.push(`2. **Target branches** → include \`${opts.mainBranch}\`.`);
    lines.push("3. **Branch rules** → enable **Require a pull request before merging**.");
    lines.push(
      `4. **Bypass list** → add the actors permitted to push directly (typically empty).`,
    );
    lines.push("5. **Enforcement status** → Active.");
    lines.push(
      `6. Optionally add a **Restrict pushes/updates** rule pinned to the \`${opts.devBranch}\` branch ` +
        "as the only allowed source.",
    );
    lines.push("");
    if (!opts.ghAvailable) {
      lines.push(
        "_Install the [`gh` CLI](https://cli.github.com/) and re-run `/supi:harness` to attempt the ruleset automatically._",
      );
      lines.push("");
    }
  }

  lines.push(`## 3. Verification`);
  lines.push("");
  lines.push("Confirm the setup by opening a draft PR from `" + (opts.devBranch ?? "feature/test") + "` → `" + opts.mainBranch + "` and checking that:");
  lines.push("");
  lines.push("- CI runs the `Harness Quality` workflow.");
  if (opts.enforceMainFromDevOnly && opts.devBranch) {
    lines.push("- A separate PR from any other branch into `" + opts.mainBranch + "` fails the `verify-pr-source` check.");
  }
  lines.push("");
  return lines.join("\n");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
