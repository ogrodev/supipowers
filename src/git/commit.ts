// src/git/commit.ts — AI-powered commit orchestrator
//
// Analyzes staged/unstaged diffs, spawns an agent session to propose
// a conventional-commit plan (optionally split by file), presents
// the plan for user approval, then executes file-level staging + commit.

import type { Platform, PlatformPaths } from "../platform/types.js";
import { appendReliabilityRecord } from "../storage/reliability-metrics.js";
import { createWorkflowProgress } from "../platform/progress.js";
import { VALID_COMMIT_TYPES } from "../release/commit-types.js";
import { resolveRepoRoot } from "../workspace/repo-root.js";
import { validateCommitMessage } from "./commit-msg.js";
import { getWorkingTreeStatus } from "./status.js";
import { discoverCommitConventions } from "./conventions.js";
import { normalizeLineEndings } from "../text.js";
import { notifyInfo, notifyError, notifySuccess } from "../notifications/renderer.js";
import { modelRegistry } from "../config/model-registry-instance.js";
import { resolveAllCandidates, createModelBridge } from "../config/model-resolver.js";
import { loadModelConfig } from "../config/model-config.js";

// ── Public types ───────────────────────────────────────────

import { CommitPlanSchema, validateCommitPlanCoverage, type CommitGroup, type CommitPlan } from "./commit-contract.js";
import { parseStructuredOutput, runWithOutputValidation, formatValidationErrors } from "../ai/structured-output.js";
import { renderSchemaText } from "../ai/schema-text.js";

export type { CommitGroup, CommitPlan };

const COMMIT_PLAN_SCHEMA_TEXT = renderSchemaText(CommitPlanSchema);

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

// ── Staging context ───────────────────────────────────────────

interface CommitStagingContext {
  stagedFiles: string[];
}

async function ensureStagedChanges(
  platform: Platform,
  ctx: any,
  cwd: string,
  status: Awaited<ReturnType<typeof getWorkingTreeStatus>>,
  progress: ReturnType<typeof createProgress>,
): Promise<CommitStagingContext | null> {
  const exec = platform.exec.bind(platform);

  if (status.stagedFiles.length === 0) {
    progress.activate(1, `${status.files.length} file(s)`);
    const addResult = await exec("git", ["add", "-A"], { cwd });
    if (addResult.code !== 0) {
      notifyError(ctx, "git add failed", addResult.stderr || "Non-zero exit");
      return null;
    }
    progress.complete(1, `${status.files.length} file(s)`);
  } else {
    progress.activate(1, `${status.stagedFiles.length} staged`);
    progress.complete(1, `${status.stagedFiles.length} staged`);
  }

  const stagedFilesResult = await exec("git", ["diff", "--cached", "--name-only"], { cwd });
  if (stagedFilesResult.code !== 0) {
    notifyError(ctx, "git diff failed", stagedFilesResult.stderr || "Could not read staged files");
    return null;
  }

  const stagedFiles = normalizeLineEndings(stagedFilesResult.stdout).trim().split("\n").filter(Boolean);
  if (stagedFiles.length === 0) {
    notifyInfo(ctx, "Nothing to commit", "No changes after staging");
    return null;
  }

  return { stagedFiles };
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
  const cwd = await resolveRepoRoot(platform, ctx.cwd);
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

    const stagingContext = await ensureStagedChanges(
      platform,
      ctx,
      cwd,
      status,
      progress,
    );
    if (!stagingContext) {
      return null;
    }

    // 3. Gather diff information
    const fileList = stagingContext.stagedFiles;
    progress.activate(2, `${fileList.length} file(s)`);
    const [diffResult, statResult] = await Promise.all([
      exec("git", ["diff", "--cached"], { cwd }),
      exec("git", ["diff", "--cached", "--stat"], { cwd }),
    ]);
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
    let agentAttempts = 0;

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
            detail += ` · ${candidate.thinkingLevel} thinking`;
          }
          ctx.ui?.setStatus?.("supi-model", `Model: ${candidate.model} (${detail})`);
        }

        const agentResult = await tryAgentPlan(platform, cwd, prompt, fileList, candidate.model);
        if (agentResult.plan) {
          plan = agentResult.plan;
          progress.complete(4, `${plan.commits.length} commit(s)`);
          break;
        }

        // Store last failure reason; try next candidate
        agentReason = agentResult.reason;
        agentAttempts = agentResult.attempts;
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
      return manualFallback(platform, ctx, cwd, fileList, platform.paths, agentAttempts, reason);
    }

    // 6. Present plan for approval
    progress.activate(5);
    const planDisplay = formatPlanForDisplay(plan);
    notifyInfo(ctx, "Commit plan ready", "\n" + planDisplay);
    const commitLabel = plan.commits.length === 1
      ? `commit — ${formatCommitHeader(plan.commits[0])}`
      : `commit — apply ${plan.commits.length} commits`;
    const action = await ctx.ui.select("Proceed?", [
      commitLabel,
      "abort — cancel",
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
  /** Number of attempts made by runWithOutputValidation (0 if never reached). */
  attempts: number;
}

async function tryAgentPlan(
  platform: Platform,
  cwd: string,
  prompt: string,
  stagedFiles: string[],
  model?: string,
): Promise<AgentPlanResult> {
  try {
    const result = await runWithOutputValidation<CommitPlan>(
      platform.createAgentSession.bind(platform),
      {
        cwd,
        prompt,
        schema: COMMIT_PLAN_SCHEMA_TEXT,
        parse: (raw) => parseStructuredOutput<CommitPlan>(raw, CommitPlanSchema),
        model,
        maxAttempts: 3,
        reliability: {
          paths: platform.paths,
          cwd,
          command: "commit",
          operation: "commit-plan",
        },
      },
    );

    if (result.status === "blocked") {
      return { plan: null, reason: result.error, attempts: result.attempts };
    }

    const coverageErrors = validateCommitPlanCoverage(result.output, stagedFiles);
    if (coverageErrors.length > 0) {
      return {
        plan: null,
        reason: `Commit plan coverage check failed: ${formatValidationErrors(coverageErrors).join("; ")}`,
        attempts: result.attempts,
      };
    }

    return { plan: result.output, attempts: result.attempts };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { plan: null, reason: message, attempts: 0 };
  }
}

// ── Manual fallback ────────────────────────────────────────

async function manualFallback(
  platform: Platform,
  ctx: any,
  cwd: string,
  fileList: string[],
  paths: PlatformPaths,
  attempts: number,
  reason?: string,
): Promise<CommitResult | null> {
  const exec = platform.exec.bind(platform);

  try {
    appendReliabilityRecord(paths, cwd, {
      ts: new Date().toISOString(),
      command: "commit",
      operation: "commit-plan",
      outcome: "fallback",
      attempts,
      reason,
      cwd,
    });
  } catch {}

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
