// src/git/commit.ts — AI-powered commit orchestrator
//
// Analyzes staged/unstaged diffs, spawns an agent session to propose
// a conventional-commit plan (optionally split by file), presents
// the plan for user approval, then executes file-level staging + commit.

import type { Platform } from "../platform/types.js";
import { createWorkflowProgress } from "../platform/progress.js";
import { VALID_COMMIT_TYPES } from "../release/commit-types.js";
import { validateCommitMessage } from "./commit-msg.js";
import { getWorkingTreeStatus } from "./status.js";
import { discoverCommitConventions } from "./conventions.js";
import { normalizeLineEndings } from "../text.js";
import { notifyInfo, notifyError, notifySuccess } from "../notifications/renderer.js";
import { modelRegistry } from "../config/model-registry-instance.js";
import { resolveAllCandidates, createModelBridge } from "../config/model-resolver.js";
import { loadModelConfig } from "../config/model-config.js";

// ── Public types ───────────────────────────────────────────

export interface CommitGroup {
  type: string;
  scope: string | null;
  summary: string;
  details: string[];
  files: string[];
}

export interface CommitPlan {
  commits: CommitGroup[];
}

export interface CommitResult {
  committed: number;
  messages: string[];
}

export interface CommitOptions {
  /** Optional user hint forwarded to the agent (e.g. "fixing the auth bug") */
  userContext?: string;
}

// ── Shared commit primitive ─────────────────────────────────

/** Minimal exec function signature for commitStaged. */
type ExecFn = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string; code: number }>;

export interface CommitStagedResult {
  success: boolean;
  /** Human-readable error. Present only when success is false. */
  error?: string;
}

/**
 * Validate a commit message and run `git commit` on whatever is currently staged.
 *
 * This is the single commit primitive shared between `supi:commit` (AI-powered
 * plans) and `supi:release` (executor). It ensures every commit in the project
 * passes the same validation and respects any git hooks.
 *
 * Callers are responsible for staging files before calling this function.
 */
export async function commitStaged(
  exec: ExecFn,
  cwd: string,
  message: string,
): Promise<CommitStagedResult> {
  const validation = validateCommitMessage(message);
  if (!validation.valid) {
    return { success: false, error: `Invalid commit message: ${validation.error}` };
  }

  const result = await exec("git", ["commit", "-m", message], { cwd });
  if (result.code !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || `exit code ${result.code}`;
    return { success: false, error: `git commit: ${detail}` };
  }

  return { success: true };
}


// ── Constants ──────────────────────────────────────────────

/** Diff byte budget before we truncate */
const DIFF_FULL_LIMIT = 30_000;
/** Beyond this we only send stat + file list */
const DIFF_STAT_ONLY_LIMIT = 60_000;
/** Max lines of diff to include when truncating */
const DIFF_TRUNCATED_LINES = 200;

// ── Main entry point ───────────────────────────────────────

// ── Commit progress tracker ────────────────────────────────

const COMMIT_STEPS = [
  { key: "check-working-tree", label: "Check working tree" },
  { key: "stage-changes", label: "Stage changes" },
  { key: "read-diff", label: "Read diff" },
  { key: "scan-conventions", label: "Scan conventions" },
  { key: "ai-analysis", label: "AI analysis" },
  { key: "review-plan", label: "Review plan" },
  { key: "execute-commits", label: "Execute commits" },
] as const;

function createProgress(ctx: any) {
  const progress = createWorkflowProgress(ctx.ui, {
    title: "supi:commit",
    statusKey: "supi-commit",
    widgetKey: "supi-commit",
    clearStatusKeys: ["supi-model"],
    steps: [...COMMIT_STEPS],
  });

  return {
    activate(stepIndex: number, detail?: string) {
      progress.activate(COMMIT_STEPS[stepIndex]!.key, detail);
    },
    detail(text: string) {
      progress.detail(text);
    },
    complete(stepIndex: number, detail?: string) {
      progress.complete(COMMIT_STEPS[stepIndex]!.key, detail);
    },
    skip(stepIndex: number, detail?: string) {
      progress.skip(COMMIT_STEPS[stepIndex]!.key, detail);
    },
    dispose() {
      progress.dispose();
    },
  };
}

// ── Main entry point ───────────────────────────────────────

/**
 * Analyze working-tree changes and commit them with AI-generated messages.
 *
 * Returns a CommitResult on success, or null if the user aborted / tree was clean.
 */
export async function analyzeAndCommit(
  platform: Platform,
  ctx: any,
  options: CommitOptions = {},
): Promise<CommitResult | null> {
  const exec = platform.exec.bind(platform);
  const cwd: string = ctx.cwd;
  const progress = createProgress(ctx);

  try {
    // 1. Check dirty
    progress.activate(0);
    const status = await getWorkingTreeStatus(exec, cwd);
    if (!status.dirty) {
      progress.complete(0, "clean");
      progress.dispose();
      notifyInfo(ctx, "Nothing to commit", "Working tree is clean");
      return null;
    }
    progress.complete(0, `${status.files.length} file(s)`);

    // 2. Stage everything (match OMP behavior: include untracked)
    progress.activate(1, `${status.files.length} file(s)`);
    const addResult = await exec("git", ["add", "-A"], { cwd });
    if (addResult.code !== 0) {
      progress.dispose();
      notifyError(ctx, "git add failed", addResult.stderr || "Non-zero exit");
      return null;
    }
    progress.complete(1, `${status.files.length} file(s)`);

    // 3. Gather diff information
    progress.activate(2);
    const [diffResult, statResult, filesResult] = await Promise.all([
      exec("git", ["diff", "--cached"], { cwd }),
      exec("git", ["diff", "--cached", "--stat"], { cwd }),
      exec("git", ["diff", "--cached", "--name-only"], { cwd }),
    ]);

    const fileList = normalizeLineEndings(filesResult.stdout).trim().split("\n").filter(Boolean);
    if (fileList.length === 0) {
      progress.complete(2, "empty");
      progress.dispose();
      notifyInfo(ctx, "Nothing to commit", "No changes after staging");
      await exec("git", ["reset", "HEAD"], { cwd });
      return null;
    }
    progress.complete(2, `${fileList.length} file(s)`);

    // 4. Discover conventions
    progress.activate(3);
    const conventions = await discoverCommitConventions(exec, cwd);
    progress.complete(3, conventions.guidelines ? "found" : "none");

    // 5. Build prompt & try AI analysis
    const prompt = buildAnalysisPrompt({
      diff: diffResult.stdout,
      stat: statResult.stdout,
      fileList,
      conventions: conventions.guidelines,
      userContext: options.userContext,
    });

    let plan: CommitPlan | null = null;
    let agentReason: string | undefined;

    if (platform.capabilities.agentSessions) {
      progress.activate(4, `${fileList.length} file(s)`);
      const modelCfg = loadModelConfig(platform.paths, cwd);
      const bridge = createModelBridge(platform);
      const candidates = resolveAllCandidates("commit", modelRegistry, modelCfg, bridge);

      for (const candidate of candidates) {
        // Show model override in status bar if not using the main session model
        if (candidate.source !== "main" && candidate.model) {
          const sourceLabel =
            candidate.source === "action" ? "configured for commit" :
            candidate.source === "default" ? "supipowers default" :
            "harness role";
          let detail = sourceLabel;
          if (candidate.thinkingLevel) {
            detail += ` \u00b7 ${candidate.thinkingLevel} thinking`;
          }
          ctx.ui?.setStatus?.("supi-model", `Model: ${candidate.model} (${detail})`);
        }

        const agentResult = await tryAgentPlan(platform, cwd, prompt, candidate.model);
        if (agentResult.plan) {
          plan = validatePlanFiles(agentResult.plan, fileList);
          progress.complete(4, `${plan.commits.length} commit(s)`);
          break;
        }

        // Store last failure reason; try next candidate
        agentReason = agentResult.reason;
      }

      if (!plan) {
        progress.skip(4, agentReason ?? "unavailable");
      }
    } else {
      progress.skip(4, "no agent sessions");
    }

    if (!plan) {
      // Skip remaining tracked steps for the manual path
      progress.skip(5, "manual");
      progress.skip(6, "manual");
      progress.dispose();
      const reason = !platform.capabilities.agentSessions
        ? "no agent sessions"
        : agentReason;
      return manualFallback(platform, ctx, cwd, fileList, reason);
    }

    // 6. Present plan for approval
    progress.activate(5);
    const planDisplay = formatPlanForDisplay(plan);
    notifyInfo(ctx, "Commit plan ready", "\n" + planDisplay);
    const commitLabel = plan.commits.length === 1
      ? `commit \u2014 ${formatCommitHeader(plan.commits[0])}`
      : `commit \u2014 apply ${plan.commits.length} commits`;
    const action = await ctx.ui.select("Proceed?", [
      commitLabel,
      "abort \u2014 cancel",
    ]);

    if (!action || action.startsWith("abort")) {
      progress.complete(5, "aborted");
      progress.dispose();
      notifyInfo(ctx, "Commit cancelled", "No changes were committed");
      return null;
    }
    progress.complete(5, "approved");

    // 7. Execute commits
    progress.activate(6, `0/${plan.commits.length}`);
    return executeCommitPlan(platform, ctx, cwd, plan, fileList, progress);
  } finally {
    // Always clean up, even on unexpected errors
    progress.dispose();
  }
}

// ── Agent interaction ──────────────────────────────────────

interface AgentPlanResult {
  plan: CommitPlan | null;
  /** Human-readable reason when plan is null */
  reason?: string;
}

async function tryAgentPlan(
  platform: Platform,
  cwd: string,
  prompt: string,
  model?: string,
): Promise<AgentPlanResult> {
  let session: Awaited<ReturnType<Platform["createAgentSession"]>> | null = null;
  try {
    session = await platform.createAgentSession({ cwd, hasUI: false, ...(model ? { model } : {}) });

    const agentDone = new Promise<void>((resolve) => {
      session!.subscribe((event: any) => {
        if (event.type === "agent_end") resolve();
      });
    });

    await session.prompt(prompt);
    await agentDone;

    // Extract JSON from the last assistant message
    const messages = session.state.messages;
    const lastAssistant = [...messages]
      .reverse()
      .find((m: any) => m.role === "assistant");

    if (!lastAssistant) return { plan: null, reason: "no assistant response" };

    const text =
      typeof lastAssistant.content === "string"
        ? lastAssistant.content
        : Array.isArray(lastAssistant.content)
          ? lastAssistant.content
              .filter((b: any) => b.type === "text")
              .map((b: any) => b.text)
              .join("\n")
          : "";

    if (!text) return { plan: null, reason: "empty agent response" };

    const plan = parseCommitPlan(text);
    if (!plan) return { plan: null, reason: diagnoseParseFailure(text) };

    return { plan };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { plan: null, reason: message };
  } finally {
    if (session) {
      try {
        await session.dispose();
      } catch {
        // Swallow disposal errors
      }
    }
  }
}

// ── Manual fallback ────────────────────────────────────────

async function manualFallback(
  platform: Platform,
  ctx: any,
  cwd: string,
  fileList: string[],
  reason?: string,
): Promise<CommitResult | null> {
  const exec = platform.exec.bind(platform);

  notifyInfo(
    ctx,
    "AI commit unavailable",
    reason
      ? `${reason} \u2014 enter a commit message manually`
      : "Enter a commit message manually",
  );

  const message = await ctx.ui.input("Commit message (empty to abort)", {
    helpText: `${fileList.length} file(s) staged`,
  });

  if (!message?.trim()) {
    notifyInfo(ctx, "Commit cancelled", "No message provided");
    return null;
  }

  const commitResult = await commitStaged(exec, cwd, message);
  if (!commitResult.success) {
    notifyError(ctx, "Commit failed", commitResult.error);
    return null;
  }

  notifySuccess(ctx, "Committed", message.split("\n")[0]);
  return { committed: 1, messages: [message] };
}

// ── Plan validation ────────────────────────────────────────

/**
 * Filter an AI-generated commit plan against the actual staged file list.
 * Removes hallucinated paths that aren't staged, and drops empty groups.
 * Falls back to the original plan if filtering would leave nothing.
 */
export function validatePlanFiles(plan: CommitPlan, stagedFiles: string[]): CommitPlan {
  const stagedSet = new Set(stagedFiles);
  const validCommits = plan.commits
    .map((group) => ({
      ...group,
      files: group.files.filter((f) => stagedSet.has(f)),
    }))
    .filter((group) => group.files.length > 0);

  return validCommits.length > 0 ? { commits: validCommits } : plan;
}


// ── Commit execution ───────────────────────────────────────

async function executeCommitPlan(
  platform: Platform,
  ctx: any,
  cwd: string,
  plan: CommitPlan,
  stagedFiles: string[],
  progress: ReturnType<typeof createProgress>,
): Promise<CommitResult | null> {
  const exec = platform.exec.bind(platform);
  const committedMessages: string[] = [];

  // Snapshot the full index as a tree object. This lets us restore the
  // staging area for each commit group via `git read-tree` — which reads
  // from git's object store and never consults .gitignore.
  const writeTreeResult = await exec("git", ["write-tree"], { cwd });
  if (writeTreeResult.code !== 0) {
    progress.dispose();
    notifyError(ctx, "Commit failed", "Could not snapshot index (git write-tree)");
    return null;
  }
  const savedTree = writeTreeResult.stdout.trim();

  for (let i = 0; i < plan.commits.length; i++) {
    const group = plan.commits[i];
    const header = formatCommitMessage(group).split("\n")[0];
    progress.detail(`${i + 1}/${plan.commits.length}: ${header}`);

    // Restore the full saved index (no gitignore involvement)
    await exec("git", ["read-tree", savedTree], { cwd });

    // Unstage everything NOT in this group
    const groupSet = new Set(group.files);
    const filesToUnstage = stagedFiles.filter((f) => !groupSet.has(f));
    if (filesToUnstage.length > 0) {
      await exec("git", ["reset", "HEAD", "--", ...filesToUnstage], { cwd });
    }

    const message = formatCommitMessage(group);
    const commitResult = await commitStaged(exec, cwd, message);
    if (!commitResult.success) {
      progress.dispose();
      // Restore full staging area so the user isn't left with a partial index
      await exec("git", ["read-tree", savedTree], { cwd });
      return reportPartialFailure(ctx, committedMessages, {
        step: `Commit ${i + 1}/${plan.commits.length}`,
        error: commitResult.error!,
      });
    }

    committedMessages.push(message);
  }

  // Restore the saved index so any staged files NOT in the plan remain staged.
  // Files already committed now match HEAD, so they appear as not-staged.
  await exec("git", ["read-tree", savedTree], { cwd });

  progress.complete(6, `${committedMessages.length} done`);
  progress.dispose();
  notifySuccess(
    ctx,
    `${committedMessages.length} commit(s) created`,
    committedMessages.map((m) => m.split("\n")[0]).join(" | "),
  );

  return { committed: committedMessages.length, messages: committedMessages };
}

/**
 * Report a mid-plan failure with context on what succeeded and what failed.
 */
function reportPartialFailure(
  ctx: any,
  committedMessages: string[],
  failure: { step: string; error: string },
): CommitResult | null {
  const lines: string[] = [];
  lines.push(`Failed at ${failure.step}: ${failure.error}`);

  if (committedMessages.length > 0) {
    lines.push("");
    lines.push(`${committedMessages.length} commit(s) succeeded before the failure:`);
    for (const msg of committedMessages) {
      lines.push(`  ✓ ${msg.split("\n")[0]}`);
    }
    lines.push("");
    lines.push("Remaining changes are staged — run /supi:commit again to continue.");
  }

  notifyError(ctx, "Commit failed", lines.join("\n"));

  // Return partial result if any commits succeeded, null otherwise
  if (committedMessages.length > 0) {
    return { committed: committedMessages.length, messages: committedMessages };
  }
  return null;
}

// ── Prompt construction ────────────────────────────────────

interface PromptInput {
  diff: string;
  stat: string;
  fileList: string[];
  conventions: string;
  userContext?: string;
}

/** Exported for testing */
export function buildAnalysisPrompt(input: PromptInput): string {
  const { diff, stat, fileList, conventions, userContext } = input;
  const normalizedDiff = normalizeLineEndings(diff);

  const parts: string[] = [
    "You are a commit message generator. Analyze the following code changes and produce a commit plan.",
    "",
    `**Valid commit types:** ${VALID_COMMIT_TYPES.join(", ")}`,
    "",
  ];

  if (conventions) {
    parts.push(
      "**Repository commit conventions:**",
      conventions,
      "",
    );
  }

  if (userContext) {
    parts.push(`**Developer context:** ${userContext}`, "");
  }

  // Diff content — truncate for large diffs
  const diffBytes = Buffer.byteLength(normalizedDiff, "utf8");

  if (diffBytes <= DIFF_FULL_LIMIT) {
    parts.push("**Full diff:**", "```", normalizedDiff, "```", "");
  } else if (diffBytes <= DIFF_STAT_ONLY_LIMIT) {
    const truncated = normalizedDiff.split("\n").slice(0, DIFF_TRUNCATED_LINES).join("\n");
    parts.push(
      "**Diff (truncated — too large for full inclusion):**",
      "```",
      truncated,
      "```",
      "",
    );
  }
  // Always include stat + file list for orientation
  parts.push("**Diff stat:**", "```", stat, "```", "");
  parts.push("**Changed files:**", fileList.map((f) => `- ${f}`).join("\n"), "");

  parts.push(
    "**Instructions:**",
    "- Analyze the changes and produce a commit plan as a JSON fenced code block.",
    "- If changes are logically distinct, split into multiple commits grouped by file.",
    "- Each file must appear in exactly one commit group — no file in multiple commits, no file missing.",
    "- Order commits so dependencies come first (e.g., types before consumers).",
    "- Use the conventional commit format: type(scope): summary",
    "- Keep summaries concise (< 72 chars).",
    "",
    "**Output format — a single ```json fenced block:**",
    "```json",
    '{',
    '  "commits": [',
    '    {',
    '      "type": "feat",',
    '      "scope": "auth",',
    '      "summary": "add login endpoint",',
    '      "details": ["Implements /api/login", "Adds JWT token generation"],',
    '      "files": ["src/auth/login.ts", "src/auth/jwt.ts"]',
    '    }',
    '  ]',
    '}',
    "```",
  );

  return parts.join("\n");
}

// ── Plan parsing ───────────────────────────────────────────

/**
 * Produce a human-readable reason why parseCommitPlan returned null.
 * Used for diagnostics — never shown raw to the user.
 */
function diagnoseParseFailure(text: string): string {
  const fenceRe = /```json\s*\n([\s\S]*?)```/;
  const match = fenceRe.exec(text);
  if (!match) return "no JSON code block in response";

  let parsed: any;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return "JSON parse error in response";
  }

  if (!parsed.commits || !Array.isArray(parsed.commits)) return "missing commits array";
  if (parsed.commits.length === 0) return "empty commits array";

  for (const c of parsed.commits) {
    if (!c.type) return "commit missing type";
    if (!c.summary) return "commit missing summary";
    if (!Array.isArray(c.files) || c.files.length === 0) return "commit missing files";
    if (!(VALID_COMMIT_TYPES as readonly string[]).includes(c.type)) {
      return `invalid commit type: ${c.type}`;
    }
  }

  // Check for duplicate files across groups
  const seen = new Set<string>();
  for (const group of parsed.commits) {
    for (const file of group.files) {
      if (seen.has(file)) return `duplicate file across commits: ${file}`;
      seen.add(file);
    }
  }

  return "unknown parse failure";
}


/** Exported for testing */
export function parseCommitPlan(text: string): CommitPlan | null {
  // Look for ```json ... ``` fenced block
  const fenceRe = /```json\s*\n([\s\S]*?)```/;
  const match = fenceRe.exec(text);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[1]);
    if (!parsed.commits || !Array.isArray(parsed.commits)) return null;

    const commits: CommitGroup[] = [];
    for (const c of parsed.commits) {
      if (!c.type || !c.summary || !Array.isArray(c.files) || c.files.length === 0) {
        return null;
      }
      if (!(VALID_COMMIT_TYPES as readonly string[]).includes(c.type)) {
        return null;
      }
      commits.push({
        type: c.type,
        scope: c.scope ?? null,
        summary: String(c.summary),
        details: Array.isArray(c.details) ? c.details.map(String) : [],
        files: c.files.map(String),
      });
    }

    if (commits.length === 0) return null;

    // Validate: no duplicate files across groups
    const seen = new Set<string>();
    for (const group of commits) {
      for (const file of group.files) {
        if (seen.has(file)) return null;
        seen.add(file);
      }
    }

    return { commits };
  } catch {
    return null;
  }
}

// ── Formatting ─────────────────────────────────────────────

function formatCommitMessage(group: CommitGroup): string {
  const header = group.scope
    ? `${group.type}(${group.scope}): ${group.summary}`
    : `${group.type}: ${group.summary}`;

  if (group.details.length === 0) return header;

  const body = group.details.map((d) => `- ${d}`).join("\n");
  return `${header}\n\n${body}`;
}

function formatCommitHeader(c: CommitGroup): string {
  return c.scope ? `${c.type}(${c.scope}): ${c.summary}` : `${c.type}: ${c.summary}`;
}

function formatPlanForDisplay(plan: CommitPlan): string {
  return plan.commits
    .map((c, i) => {
      const header = formatCommitHeader(c);
      const files = c.files.length <= 4
        ? c.files.join(", ")
        : c.files.slice(0, 3).join(", ") + ` (+${c.files.length - 3} more)`;
      return `${i + 1}. ${header}\n   ${files}`;
    })
    .join("\n");
}
