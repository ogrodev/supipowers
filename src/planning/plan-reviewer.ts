/**
 * Build the prompt for dispatching a plan document reviewer sub-agent.
 * Follows the same pattern as superpowers' plan-document-reviewer-prompt.md.
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
    "| Completeness | TODO markers, placeholders, incomplete tasks, missing steps |",
    "| Spec Alignment | Chunk covers relevant spec requirements, no scope creep |",
    "| Task Decomposition | Tasks atomic, clear boundaries, steps actionable |",
    "| File Structure | Files have clear single responsibilities, split by responsibility not layer |",
    "| File Size | Would any new or modified file likely grow large enough to be hard to reason about? |",
    "| Checkbox Syntax | Steps use checkbox (`- [ ]`) syntax for tracking |",
    "| Chunk Size | Each chunk under 1000 lines |",
    "",
    "## Critical",
    "",
    "Look especially hard for:",
    "- Any TODO markers or placeholder text",
    '- Steps that say "similar to X" without actual content',
    "- Incomplete task definitions",
    "- Missing verification steps or expected outputs",
    "- Files planned to hold multiple responsibilities or likely to grow unwieldy",
    "",
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
