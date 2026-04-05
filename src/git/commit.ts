// src/git/commit.ts — AI-powered commit orchestrator
//
// Analyzes staged/unstaged diffs, spawns an agent session to propose
// a conventional-commit plan (optionally split by file), presents
// the plan for user approval, then executes file-level staging + commit.

import type { Platform } from "../platform/types.js";
import { VALID_COMMIT_TYPES } from "../release/commit-types.js";
import { validateCommitMessage } from "./commit-msg.js";
import { getWorkingTreeStatus } from "./status.js";
import { discoverCommitConventions } from "./conventions.js";
import { notifyInfo, notifyError, notifySuccess } from "../notifications/renderer.js";
import { modelRegistry } from "../config/model-registry-instance.js";
import { resolveModelForAction, createModelBridge } from "../config/model-resolver.js";
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

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const STATUS_KEY = "supi-commit";
const WIDGET_KEY = "supi-commit";

/** A named step in the commit workflow. */
interface Step {
  label: string;
  status: "pending" | "active" | "done" | "skipped";
  detail?: string;
}

/**
 * Rich progress tracker for the commit flow.
 *
 * Uses `setWidget` for a persistent multi-line panel showing all steps,
 * and `setStatus` for the current operation detail in the footer.
 */
function createProgress(ctx: any) {
  const steps: Step[] = [
    { label: "Check working tree", status: "pending" },
    { label: "Stage changes", status: "pending" },
    { label: "Read diff", status: "pending" },
    { label: "Scan conventions", status: "pending" },
    { label: "AI analysis", status: "pending" },
    { label: "Review plan", status: "pending" },
    { label: "Execute commits", status: "pending" },
  ];

  let frame = 0;
  let statusDetail = "";
  let timer: ReturnType<typeof setInterval> | null = null;

  function icon(step: Step): string {
    switch (step.status) {
      case "done":    return "✓";
      case "active":  return SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
      case "skipped": return "–";
      default:        return "○";
    }
  }

  function renderWidget(): string[] {
    const lines: string[] = ["┌─ supi:commit ─────────────────────┐"];
    for (const step of steps) {
      const mark = icon(step);
      const detail = step.detail ? ` (${step.detail})` : "";
      lines.push(`│ ${mark} ${step.label}${detail}`);
    }
    lines.push("└───────────────────────────────────┘");
    return lines;
  }

  function refresh() {
    frame++;
    ctx.ui.setWidget?.(WIDGET_KEY, renderWidget());
    if (statusDetail) {
      ctx.ui.setStatus?.(STATUS_KEY, `${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} ${statusDetail}`);
    }
  }

  function startTimer() {
    if (!timer) {
      timer = setInterval(refresh, 80);
    }
  }

  function stopTimer() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    /**
     * Mark a step as active (in progress) with an optional status-bar detail.
     * `stepIndex` is 0-based into the steps array.
     */
    activate(stepIndex: number, detail?: string) {
      const step = steps[stepIndex];
      if (step) {
        step.status = "active";
        step.detail = detail;
      }
      statusDetail = detail ?? step?.label ?? "";
      startTimer();
      refresh();
    },

    /** Update the status-bar detail text without changing the step. */
    detail(text: string) {
      statusDetail = text;
      // Also update the current active step's detail
      const active = steps.find((s) => s.status === "active");
      if (active) active.detail = text;
    },

    /** Mark a step as completed. */
    complete(stepIndex: number, detail?: string) {
      const step = steps[stepIndex];
      if (step) {
        step.status = "done";
        if (detail !== undefined) step.detail = detail;
      }
      refresh();
    },

    /** Mark a step as skipped. */
    skip(stepIndex: number, detail?: string) {
      const step = steps[stepIndex];
      if (step) {
        step.status = "skipped";
        if (detail !== undefined) step.detail = detail;
      }
      refresh();
    },

    /** Tear down: stop animation, clear status bar and widget. */
    dispose() {
      stopTimer();
      ctx.ui.setStatus?.(STATUS_KEY, undefined);
      ctx.ui.setStatus?.("supi-model", undefined);
      ctx.ui.setWidget?.(WIDGET_KEY, undefined);
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

    const fileList = filesResult.stdout.trim().split("\n").filter(Boolean);
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

    if (platform.capabilities.agentSessions) {
      progress.activate(4, `${fileList.length} file(s)`);
      // Resolve the commit sub-agent model from config (falls back to session default)
      const modelCfg = loadModelConfig(platform.paths, cwd);
      const bridge = createModelBridge(platform);
      const commitModel = resolveModelForAction("commit", modelRegistry, modelCfg, bridge);

      // Show model override in status bar if not using the main session model
      if (commitModel.source !== "main" && commitModel.model) {
        const sourceLabel =
          commitModel.source === "action" ? "configured for commit" :
          commitModel.source === "default" ? "supipowers default" :
          "harness role";
        let detail = sourceLabel;
        if (commitModel.thinkingLevel) {
          detail += ` \u00b7 ${commitModel.thinkingLevel} thinking`;
        }
        ctx.ui?.setStatus?.("supi-model", `Model: ${commitModel.model} (${detail})`);
      }
      plan = await tryAgentPlan(platform, cwd, prompt, commitModel.model);
      if (plan) {
        plan = validatePlanFiles(plan, fileList);
        progress.complete(4, `${plan.commits.length} commit(s)`);
      } else {
        progress.skip(4, "unavailable");
      }
    } else {
      progress.skip(4, "no agent sessions");
    }

    if (!plan) {
      // Skip remaining tracked steps for the manual path
      progress.skip(5, "manual");
      progress.skip(6, "manual");
      progress.dispose();
      return manualFallback(platform, ctx, cwd, fileList);
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

async function tryAgentPlan(
  platform: Platform,
  cwd: string,
  prompt: string,
  model?: string,
): Promise<CommitPlan | null> {
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

    if (!lastAssistant) return null;

    const text =
      typeof lastAssistant.content === "string"
        ? lastAssistant.content
        : Array.isArray(lastAssistant.content)
          ? lastAssistant.content
              .filter((b: any) => b.type === "text")
              .map((b: any) => b.text)
              .join("\n")
          : "";

    return parseCommitPlan(text);
  } catch {
    return null;
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
): Promise<CommitResult | null> {
  const exec = platform.exec.bind(platform);

  notifyInfo(
    ctx,
    "AI commit unavailable",
    "Enter a commit message manually",
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
  const diffBytes = Buffer.byteLength(diff, "utf8");

  if (diffBytes <= DIFF_FULL_LIMIT) {
    parts.push("**Full diff:**", "```", diff, "```", "");
  } else if (diffBytes <= DIFF_STAT_ONLY_LIMIT) {
    const truncated = diff.split("\n").slice(0, DIFF_TRUNCATED_LINES).join("\n");
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
