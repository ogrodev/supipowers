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

// ── Constants ──────────────────────────────────────────────

/** Diff byte budget before we truncate */
const DIFF_FULL_LIMIT = 30_000;
/** Beyond this we only send stat + file list */
const DIFF_STAT_ONLY_LIMIT = 60_000;
/** Max lines of diff to include when truncating */
const DIFF_TRUNCATED_LINES = 200;

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

  // 1. Check dirty
  const status = await getWorkingTreeStatus(exec, cwd);
  if (!status.dirty) {
    notifyInfo(ctx, "Nothing to commit", "Working tree is clean");
    return null;
  }

  // 2. Stage everything (match OMP behavior: include untracked)
  const addResult = await exec("git", ["add", "-A"], { cwd });
  if (addResult.code !== 0) {
    notifyError(ctx, "git add failed", addResult.stderr || "Non-zero exit");
    return null;
  }

  // 3. Gather diff information
  const [diffResult, statResult, filesResult] = await Promise.all([
    exec("git", ["diff", "--cached"], { cwd }),
    exec("git", ["diff", "--cached", "--stat"], { cwd }),
    exec("git", ["diff", "--cached", "--name-only"], { cwd }),
  ]);

  const fileList = filesResult.stdout.trim().split("\n").filter(Boolean);
  if (fileList.length === 0) {
    // Nothing staged after add — e.g. only .gitignore changes
    notifyInfo(ctx, "Nothing to commit", "No changes after staging");
    await exec("git", ["reset", "HEAD"], { cwd });
    return null;
  }

  // 4. Discover conventions
  const conventions = await discoverCommitConventions(exec, cwd);

  // 5. Build prompt
  const prompt = buildAnalysisPrompt({
    diff: diffResult.stdout,
    stat: statResult.stdout,
    fileList,
    conventions: conventions.guidelines,
    userContext: options.userContext,
  });

  // 6. Try agent session; fall back to manual input
  let plan: CommitPlan | null = null;

  if (platform.capabilities.agentSessions) {
    plan = await tryAgentPlan(platform, cwd, prompt);
  }

  if (!plan) {
    return manualFallback(platform, ctx, cwd, fileList);
  }

  // 7. Present plan for approval
  const summary = formatPlanSummary(plan);
  const action = await ctx.ui.select("Commit plan", [
    `commit — ${summary}`,
    "abort — cancel",
  ]);

  if (!action || action.startsWith("abort")) {
    notifyInfo(ctx, "Commit cancelled", "No changes were committed");
    // Leave everything staged — user can re-run or handle manually
    return null;
  }

  // 8. Execute commits
  return executeCommitPlan(platform, ctx, cwd, plan);
}

// ── Agent interaction ──────────────────────────────────────

async function tryAgentPlan(
  platform: Platform,
  cwd: string,
  prompt: string,
): Promise<CommitPlan | null> {
  let session: Awaited<ReturnType<Platform["createAgentSession"]>> | null = null;
  try {
    session = await platform.createAgentSession({ cwd });

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

  const validation = validateCommitMessage(message);
  if (!validation.valid) {
    notifyError(ctx, "Invalid commit message", validation.error);
    return null;
  }

  const commitResult = await exec(
    "git",
    ["commit", "-m", message],
    { cwd },
  );

  if (commitResult.code !== 0) {
    notifyError(ctx, "git commit failed", commitResult.stderr || "Non-zero exit");
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
): Promise<CommitResult | null> {
  const exec = platform.exec.bind(platform);
  const committedMessages: string[] = [];

  for (const group of plan.commits) {
    // Reset staging area
    await exec("git", ["reset", "HEAD"], { cwd });

    // Stage only this group's files
    const addResult = await exec("git", ["add", ...group.files], { cwd });
    if (addResult.code !== 0) {
      notifyError(
        ctx,
        "Staging failed",
        `Could not stage files for: ${group.summary}`,
      );
      // Re-stage everything so user isn't left in a weird state
      await exec("git", ["add", "-A"], { cwd });
      return null;
    }

    // Build commit message
    const message = formatCommitMessage(group);

    const validation = validateCommitMessage(message);
    if (!validation.valid) {
      notifyError(
        ctx,
        "Invalid commit message from AI",
        `${validation.error}\nMessage: ${message}`,
      );
      await exec("git", ["add", "-A"], { cwd });
      return null;
    }

    const commitResult = await exec(
      "git",
      ["commit", "-m", message],
      { cwd },
    );

    if (commitResult.code !== 0) {
      notifyError(
        ctx,
        "git commit failed",
        commitResult.stderr || "Non-zero exit",
      );
      await exec("git", ["add", "-A"], { cwd });
      return null;
    }

    committedMessages.push(message);
  }

  notifySuccess(
    ctx,
    `${committedMessages.length} commit(s) created`,
    committedMessages.map((m) => m.split("\n")[0]).join(" | "),
  );

  return { committed: committedMessages.length, messages: committedMessages };
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

function formatPlanSummary(plan: CommitPlan): string {
  if (plan.commits.length === 1) {
    const c = plan.commits[0];
    const header = c.scope ? `${c.type}(${c.scope}): ${c.summary}` : `${c.type}: ${c.summary}`;
    return header;
  }
  return `${plan.commits.length} commits: ${plan.commits.map((c) => c.type + ": " + c.summary).join(" | ")}`;
}
