/**
 * Build the prompt for dispatching a spec document reviewer sub-agent.
 * Follows the same pattern as supipowers' spec-document-reviewer-prompt.md.
 */
export function buildSpecReviewerPrompt(specFilePath: string): string {
  return [
    "You are a spec-document-reviewer. Verify this spec is complete and ready for planning.",
    "",
    `**Spec to review:** ${specFilePath}`,
    "",
    "## What to Check",
    "",
    "| Category | What to Look For |",
    "|----------|------------------|",
    '| Completeness | TODO markers, placeholders, "TBD", incomplete sections |',
    "| Coverage | Missing error handling, edge cases, integration points |",
    "| Consistency | Internal contradictions, conflicting requirements |",
    "| Clarity | Ambiguous requirements that could be interpreted multiple ways |",
    "| YAGNI | Unrequested features, over-engineering, gold-plating |",
    "| Scope | Focused enough for a single plan — not covering multiple independent subsystems |",
    "| Architecture | Units with clear boundaries, well-defined interfaces, independently understandable and testable |",
    "",
    "## Critical",
    "",
    "Look especially hard for:",
    "- Any TODO markers or placeholder text",
    '- Sections saying "to be defined later" or "will spec when X is done"',
    "- Sections noticeably less detailed than others",
    "- Units that lack clear boundaries or interfaces",
    "",
    "## Output Format",
    "",
    "## Spec Review",
    "",
    "**Status:** Approved | Issues Found",
    "",
    "**Issues (if any):**",
    "- [Section X]: [specific issue] — [why it matters]",
    "",
    "**Recommendations (advisory):**",
    "- [suggestions that don't block approval]",
  ].join("\n");
}
