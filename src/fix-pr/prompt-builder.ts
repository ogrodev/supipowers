import type { FixPrConfig } from "./types.js";
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
  const { prNumber, repo, comments, sessionDir, scriptsDir, config, iteration, skillContent, taskModel } = options;
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
    `- Comment reply policy: ${config.commentPolicy}`,
    `- Reviewer: ${reviewer.type}${reviewer.triggerMethod ? ` (trigger: ${reviewer.triggerMethod})` : ""}`,
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

  // Embedded skill
  if (skillContent) {
    sections.push(
      "## Assessment Methodology",
      "",
      skillContent,
      "",
    );
  }

  // Receiving review discipline
  sections.push(
    "## Review Discipline",
    "",
    buildReceivingReviewInstructions(),
    "",
  );

  // Step 1: Assess
  sections.push(
    "## Step 1: Assess Each Comment",
    "",
    "For each comment:",
    "1. Read the actual code at the file and line referenced",
    "2. Determine the verdict: **ACCEPT** / **REJECT** / **INVESTIGATE**",
    "3. Check ripple effects — who calls this, what tests cover it",
    "4. YAGNI check — does the reviewer's suggestion address a real problem?",
    "",
    "Record your assessment:",
    "```",
    "Comment #ID by @user on file:line",
    "Verdict: ACCEPT | REJECT | INVESTIGATE",
    "Reasoning: [1-2 sentences]",
    "Ripple effects: [list or none]",
    "Group: [group-id]",
    "```",
    "",
  );

  // Step 2: Group
  sections.push(
    "## Step 2: Group Comments",
    "",
    "Group accepted comments for parallel execution:",
    "- Same file or tightly coupled files → same group",
    "- Independent files/areas → separate groups",
    "- Cosmetic vs functional → separate groups",
    "",
  );

  // Step 3: Plan
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

  // Step 4: Execute
  sections.push(
    "## Step 4: Execute Fixes",
    "",
    "For each group:",
    "1. Make the code changes",
    "2. Run relevant tests to verify",
    "3. If tests fail, fix before moving on",
    "",
  );

  // Step 5: Reply
  sections.push(buildReplyInstructions(config), "");

  // Step 6: Push and loop
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

  // Script paths reference
  sections.push(
    "## Script Paths",
    "",
    `- fetch-pr-comments.sh: \`${scriptsDir}/fetch-pr-comments.sh\``,
    `- diff-comments.sh: \`${scriptsDir}/diff-comments.sh\``,
    `- trigger-review.sh: \`${scriptsDir}/trigger-review.sh\``,
    `- wait-and-check.sh: \`${scriptsDir}/wait-and-check.sh\``,
    "",
  );

  // Model guidance
  sections.push(
    "## Model Guidance",
    "",
    `- **Orchestrator** (this session): handles assessment & grouping`,
    `- **Planner & Fixer** (sub-agents): use model \`${taskModel}\``,
    "",
    "Sub-agents inherit the task model for planning and code changes.",
  );

  return sections.join("\n");
}
