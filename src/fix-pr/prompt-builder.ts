import type { FixPrConfig } from "./types.js";
import type { FixPrAssessmentBatch, FixPrWorkBatch } from "./contracts.js";
import { FixPrAssessmentBatchSchema } from "./contracts.js";
import { renderSchemaText } from "../ai/schema-text.js";
import { buildReceivingReviewInstructions } from "../discipline/receiving-review.js";

export interface FixPrPromptOptions {
  prNumber: number;
  repo: string;
  comments: string;
  sessionDir: string;
  scriptsDir: string;
  config: FixPrConfig;
  iteration: number;
  skillContent: string;
  /** Resolved model ID for sub-agent tasks (planner, fixer roles). */
  taskModel: string;
  selectedTargetLabel: string;
  deferredCommentsSummary: string | null;
  /** Validated assessment artifact from runFixPrAssessment. */
  assessment: FixPrAssessmentBatch;
  /** Work batches derived deterministically from `assessment`. */
  workBatches: FixPrWorkBatch[];
}

function buildReplyInstructions(config: FixPrConfig): string {
  const { commentPolicy } = config;
  const replyCmd = `gh api repos/REPO/pulls/PR/comments/COMMENT_ID/replies -f body="..."`;

  switch (commentPolicy) {
    case "no-answer":
      return [
        "### Comment Replies",
        "",
        "Policy: **Do not reply** to any comments. Focus only on fixing the code.",
        "Do not post any replies via gh api.",
      ].join("\n");
    case "answer-all":
      return [
        "### Comment Replies",
        "",
        "Policy: **Answer all** comments — both accepted and rejected.",
        "For each comment, post a reply explaining what was done or why it was rejected.",
        `Use: \`${replyCmd}\``,
        "Keep replies factual and technical. No performative agreement.",
      ].join("\n");
    case "answer-selective":
      return [
        "### Comment Replies",
        "",
        "Policy: **Answer selectively** — only reply to comments you reject or where clarification adds value.",
        "For ACCEPT: fix silently (the code change speaks for itself).",
        "For REJECT: explain why with technical reasoning.",
        `Use: \`${replyCmd}\``,
        "Keep replies factual. No performative agreement.",
      ].join("\n");
  }
}

export function buildFixPrOrchestratorPrompt(options: FixPrPromptOptions): string {
  const {
    prNumber,
    repo,
    comments,
    sessionDir,
    scriptsDir,
    config,
    iteration,
    skillContent,
    taskModel,
    selectedTargetLabel,
    deferredCommentsSummary,
    assessment,
    workBatches,
  } = options;
  const { loop, reviewer } = config;
  const maxIter = loop.maxIterations;
  const delay = loop.delaySeconds;

  const sections: string[] = [
    "# PR Review Fix Orchestration",
    "",
    `You are the orchestrator for fixing PR #${prNumber} on \`${repo}\`.`,
    "",
    "## Session Context",
    "",
    `- Session dir: \`${sessionDir}\``,
    `- Iteration: ${iteration} of ${maxIter}`,
    `- Selected target: ${selectedTargetLabel}`,
    `- Comment reply policy: ${config.commentPolicy}`,
    `- Reviewer: ${reviewer.type}${reviewer.triggerMethod ? ` (trigger: ${reviewer.triggerMethod})` : ""}`,
    deferredCommentsSummary
      ? `- Deferred comments outside this target: ${deferredCommentsSummary}`
      : "- Deferred comments outside this target: none",
    "",
    "## Review Scope Rules",
    "",
    "- Process only the comments listed below for the selected target.",
    deferredCommentsSummary
      ? "- Comments outside the selected target were intentionally excluded for a separate run. Do not remediate them here."
      : "- There are no deferred comments outside this target in this snapshot.",
    "- After each wait-and-check cycle, keep enforcing the same target boundary. If new root or sibling-package comments appear, surface them explicitly and leave them for a separate run.",
    "",
    "## Review Comments to Process",
    "",
    "Each line is a JSON object with comment data:",
    "",
    "```jsonl",
    comments,
    "```",
    "",
  ];

  if (skillContent) {
    sections.push(
      "## Assessment Methodology",
      "",
      skillContent,
      "",
    );
  }

  sections.push(
    "## Review Discipline",
    "",
    buildReceivingReviewInstructions(),
    "",
  );

  sections.push(
    "## Step 1: Validated Assessment Artifact",
    "",
    "The per-comment assessment for this run has already been validated against the `FixPrAssessmentBatchSchema` contract. Treat it as the source of truth: do not re-assess, do not change verdicts. Each entry has a verdict (`apply` / `reject` / `investigate`), rationale, affectedFiles, rippleEffects (downstream callers/tests/docs), and a verificationPlan.",
    "",
    "Schema:",
    "```ts",
    renderSchemaText(FixPrAssessmentBatchSchema),
    "```",
    "",
    "Validated artifact:",
    "```json",
    JSON.stringify(assessment, null, 2),
    "```",
    "",
  );

  sections.push(
    "## Step 2: Work Batches (Parallel Execution Groups)",
    "",
    "Batches were derived deterministically from the artifact above by grouping `apply` assessments whose `affectedFiles` overlap. Independent batches may run in parallel; a batch's commentIds share at least one file and must execute together. `reject` and `investigate` verdicts produce no batch — handle those per the reply policy below.",
    "",
    "```json",
    JSON.stringify(workBatches, null, 2),
    "```",
    "",
  );

  sections.push(
    "## Step 3: Plan Each Group",
    "",
    "For each group, create a fix plan:",
    "- What changes are needed and why",
    "- Which files to modify",
    "- Expected ripple effects and how to handle them",
    "- How to verify the fix (which tests to run)",
    "",
  );

  sections.push(
    "## Step 4: Execute Fixes",
    "",
    "For each group:",
    "1. Make the code changes",
    "2. Run relevant tests to verify",
    "3. If tests fail, fix before moving on",
    "",
  );

  sections.push(buildReplyInstructions(config), "");

  sections.push(
    "## Step 6: Push and Check for New Comments",
    "",
    '1. Stage and commit: `git add -A && git commit -m "fix: address PR review comments (iteration ' + iteration + ')"`',
    "2. Push: `git push`",
  );

  if (reviewer.type !== "none" && reviewer.triggerMethod) {
    sections.push(
      `3. Trigger re-review: \`bash ${scriptsDir}/trigger-review.sh "${repo}" ${prNumber} "${reviewer.type}" "${reviewer.triggerMethod}"\``,
    );
  }

  sections.push(
    `${reviewer.type !== "none" ? "4" : "3"}. Run the check script:`,
    "```bash",
    `bash ${scriptsDir}/wait-and-check.sh "${sessionDir}" ${delay} ${iteration + 1} "${repo}" ${prNumber}`,
    "```",
    `${reviewer.type !== "none" ? "5" : "4"}. Read the last line of output:`,
    `   - If \`hasNewComments: true\` and iteration < ${maxIter}: process the new comments (go back to Step 1)`,
    `   - If \`hasNewComments: false\` or iteration >= ${maxIter}: report done`,
    "",
  );

  sections.push(
    "## Script Paths",
    "",
    `- fetch-pr-comments.sh: \`${scriptsDir}/fetch-pr-comments.sh\``,
    `- diff-comments.sh: \`${scriptsDir}/diff-comments.sh\``,
    `- trigger-review.sh: \`${scriptsDir}/trigger-review.sh\``,
    `- wait-and-check.sh: \`${scriptsDir}/wait-and-check.sh\``,
    "",
  );

  sections.push(
    "## Model Guidance",
    "",
    "- **Orchestrator** (this session): handles assessment & grouping",
    `- **Planner & Fixer** (sub-agents): use model \`${taskModel}\``,
    "",
    "Sub-agents inherit the task model for planning and code changes.",
  );

  return sections.join("\n");
}
