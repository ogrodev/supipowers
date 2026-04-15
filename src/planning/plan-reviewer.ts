import { PLAN_CODE_CONTENT_CRITICAL_CHECKS, PLAN_REVIEW_CATEGORIES } from "./plan-content-policy.js";


/**
 * Build the prompt for dispatching a plan document reviewer sub-agent.
 * Follows the same pattern as supipowers' plan-document-reviewer-prompt.md.
 */
export function buildPlanReviewerPrompt(
  planFilePath: string,
  specFilePath: string,
  chunkNumber: number,
): string {
  return [
    "You are a plan document reviewer. Verify this plan chunk is complete and ready for implementation.",
    "",
    `**Plan chunk to review:** ${planFilePath} — Chunk ${chunkNumber} only`,
    `**Spec for reference:** ${specFilePath}`,
    "",
    "## What to Check",
    "",
    "| Category | What to Look For |",
    "|----------|------------------|",
    ...PLAN_REVIEW_CATEGORIES.map(
      ({ category, detail }) => `| ${category} | ${detail} |`,
    ),
    "",
    "## Critical",
    "",
    "Look especially hard for:",
    "- Any TODO markers or placeholder text",
    '- Steps that say "similar to X" without actual content',
    "- Incomplete task definitions",
    "- Missing verification steps or expected outputs",
    "- Files planned to hold multiple responsibilities or likely to grow unwieldy",
    ...PLAN_CODE_CONTENT_CRITICAL_CHECKS.map((check) => `- ${check}`),

    "## Output Format",
    "",
    `## Plan Review — Chunk ${chunkNumber}`,
    "",
    "**Status:** Approved | Issues Found",
    "",
    "**Issues (if any):**",
    "- [Task X, Step Y]: [specific issue] — [why it matters]",
    "",
    "**Recommendations (advisory):**",
    "- [suggestions that don't block approval]",
  ].join("\n");
}
