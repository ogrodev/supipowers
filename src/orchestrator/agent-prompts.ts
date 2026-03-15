import type { PlanTask } from "../types.js";
import { buildTddInstructions } from "../discipline/tdd.js";
import { buildDebuggingInstructions } from "../discipline/debugging.js";
import { buildVerificationInstructions } from "../discipline/verification.js";

// ── Implementer Prompt ─────────────────────────────────────────────

export interface ImplementerPromptOptions {
  task: PlanTask;
  planContext: string;
  workDir: string;
}

/**
 * Build the prompt for an implementer sub-agent.
 * Follows supipowers' implementer-prompt.md pattern:
 * - Full task description
 * - Ask-before-starting section
 * - TDD and code organization guidance
 * - Escalation guidance
 * - Self-review before reporting
 * - Structured report format
 */
export function buildImplementerPrompt(
  options: ImplementerPromptOptions,
): string {
  const { task, planContext, workDir } = options;

  return [
    `You are implementing Task ${task.id}: ${task.name}`,
    "",
    "## Task Description",
    "",
    task.description,
    "",
    "## Target Files",
    "",
    ...(task.files.length > 0
      ? task.files.map((f) => `- ${f}`)
      : ["(No specific files targeted \u2014 determine from task description)"]),
    "",
    "## Acceptance Criteria",
    "",
    task.criteria,
    "",
    "## Context",
    "",
    planContext,
    "",
    `Work from: ${workDir}`,
    "",
    "## Before You Begin",
    "",
    "If you have questions about:",
    "- The requirements or acceptance criteria",
    "- The approach or implementation strategy",
    "- Dependencies or assumptions",
    "- Anything unclear in the task description",
    "",
    "**Ask them now.** Raise any concerns before starting work.",
    "",
    "## Your Job",
    "",
    "Once you're clear on requirements:",
    "1. Implement exactly what the task specifies",
    "2. Write tests following TDD (write the failing test first, then implement)",
    "3. Verify implementation works",
    "4. Commit your work",
    "5. Self-review (see below)",
    "6. Report back",
    "",
    "**While you work:** If you encounter something unexpected or unclear, ask questions.",
    "It's always OK to pause and clarify. Don't guess or make assumptions.",
    "",
    "## Code Organization",
    "",
    "- Follow the file structure defined in the plan",
    "- Each file should have one clear responsibility with a well-defined interface",
    "- If a file you're creating is growing beyond the plan's intent, stop and report as DONE_WITH_CONCERNS",
    "- In existing codebases, follow established patterns",
    "",
    "## When You're in Over Your Head",
    "",
    "It is always OK to stop and escalate. Bad work is worse than no work.",
    "",
    "**STOP and escalate when:**",
    "- The task requires architectural decisions with multiple valid approaches",
    "- You need to understand code beyond what was provided",
    "- You feel uncertain about whether your approach is correct",
    "- The task involves restructuring existing code the plan didn't anticipate",
    "",
    "**How to escalate:** Report with status BLOCKED or NEEDS_CONTEXT.",
    "Describe what you're stuck on, what you've tried, and what help you need.",
    "",
    "## Before Reporting Back: Self-Review",
    "",
    "Review your work with fresh eyes:",
    "",
    "**Completeness:**",
    "- Did I fully implement everything in the spec?",
    "- Did I miss any requirements?",
    "- Are there edge cases I didn't handle?",
    "",
    "**Quality:**",
    "- Is this my best work?",
    "- Are names clear and accurate?",
    "- Is the code clean and maintainable?",
    "",
    "**Discipline:**",
    "- Did I avoid overbuilding (YAGNI)?",
    "- Did I only build what was requested?",
    "- Did I follow existing patterns?",
    "",
    "**Testing:**",
    "- Do tests verify behavior (not mock behavior)?",
    "- Did I follow TDD?",
    "- Are tests comprehensive?",
    "",
    "If you find issues during self-review, fix them before reporting.",
    "",
    "## Report Format",
    "",
    "When done, report:",
    "- **Status:** DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT",
    "- What you implemented (or attempted, if blocked)",
    "- What you tested and test results",
    "- Files changed",
    "- Self-review findings (if any)",
    "- Any issues or concerns",
    "",
    "Use DONE_WITH_CONCERNS if you completed but have doubts.",
    "Use BLOCKED if you cannot complete the task.",
    "Use NEEDS_CONTEXT if you need information not provided.",
    "Never silently produce work you're unsure about.",
    "",
    "---",
    "",
    buildTddInstructions(),
    "",
    "---",
    "",
    buildDebuggingInstructions(),
    "",
    "---",
    "",
    buildVerificationInstructions(),
  ].join("\n");
}

// ── Spec Compliance Review Prompt ──────────────────────────────────

export interface SpecComplianceReviewOptions {
  taskRequirements: string;
  implementerReport: string;
}

/**
 * Build the prompt for a spec compliance reviewer sub-agent.
 * Follows supipowers' spec-reviewer-prompt.md pattern:
 * - Do not trust the implementer's report
 * - Verify by reading actual code
 * - Check for missing, extra, and misunderstood requirements
 */
export function buildSpecComplianceReviewPrompt(
  options: SpecComplianceReviewOptions,
): string {
  const { taskRequirements, implementerReport } = options;

  return [
    "You are reviewing whether an implementation matches its specification.",
    "",
    "## What Was Requested",
    "",
    taskRequirements,
    "",
    "## What Implementer Claims They Built",
    "",
    implementerReport,
    "",
    "## CRITICAL: Do Not Trust the Report",
    "",
    "The implementer's report may be incomplete, inaccurate, or optimistic.",
    "You MUST verify everything independently.",
    "",
    "**DO NOT:**",
    "- Take their word for what they implemented",
    "- Trust their claims about completeness",
    "- Accept their interpretation of requirements",
    "",
    "**DO:**",
    "- Read the actual code they wrote",
    "- Compare actual implementation to requirements line by line",
    "- Check for missing pieces they claimed to implement",
    "- Look for extra features they didn't mention",
    "",
    "## Your Job",
    "",
    "Read the implementation code and verify:",
    "",
    "**Missing requirements:**",
    "- Did they implement everything that was requested?",
    "- Are there requirements they skipped or missed?",
    "- Did they claim something works but didn't actually implement it?",
    "",
    "**Extra/unneeded work:**",
    "- Did they build things that weren't requested? Did they over-engineer?",
    "- Did they add unnecessary features not in spec?",
    "",
    "**Misunderstandings:**",
    "- Did they interpret requirements differently than intended?",
    "- Did they solve the wrong problem?",
    "",
    "**Verify by reading code, not by trusting report.**",
    "",
    "## Output",
    "",
    "Report:",
    "- **Spec compliant** — if everything matches after code inspection",
    "- **Issues found:** [list specifically what's missing or extra, with file:line references]",
  ].join("\n");
}

// ── Code Quality Review Prompt ─────────────────────────────────────

export interface CodeQualityReviewOptions {
  taskSummary: string;
  implementerReport: string;
  baseSha: string;
  headSha: string;
}

/**
 * Build the prompt for a code quality reviewer sub-agent.
 * Follows supipowers' code-quality-reviewer-prompt.md pattern:
 * - Review git diff between base and head
 * - Check file responsibilities and unit decomposition
 * - Categorize issues as Critical/Important/Minor
 */
export function buildCodeQualityReviewPrompt(
  options: CodeQualityReviewOptions,
): string {
  const { taskSummary, implementerReport, baseSha, headSha } = options;

  return [
    "You are reviewing code quality for a completed implementation task.",
    "",
    "## What Was Implemented",
    "",
    taskSummary,
    "",
    "## Implementer Report",
    "",
    implementerReport,
    "",
    "## Git Diff",
    "",
    `Compare changes between base (\`${baseSha}\`) and head (\`${headSha}\`):`,
    "",
    `Run: \`git diff ${baseSha}..${headSha}\``,
    "",
    "## What to Check",
    "",
    "**Architecture & Design:**",
    "- Does each file have one clear responsibility with a well-defined interface?",
    "- Are units decomposed so they can be understood and tested independently?",
    "- Did this implementation create new files that are already large?",
    "",
    "**Code Quality:**",
    "- Correctness: Does the code do what it's supposed to?",
    "- Security: Any injection, XSS, or other vulnerabilities?",
    "- Performance: Any obvious performance issues?",
    "- Maintainability: Is the code readable and well-organized?",
    "- Error handling: Are failures handled appropriately?",
    "",
    "**Testing:**",
    "- Do tests verify real behavior (not mock behavior)?",
    "- Are edge cases covered?",
    "- Is test coverage adequate?",
    "",
    "## Output",
    "",
    "Categorize issues by severity:",
    "",
    "- **Critical:** Must fix before proceeding (bugs, security issues, data loss risks)",
    "- **Important:** Should fix before merging (code quality, maintainability)",
    "- **Minor:** Nice to fix (style, naming, minor improvements)",
    "",
    "Report: Strengths, Issues (Critical/Important/Minor), Assessment",
  ].join("\n");
}
