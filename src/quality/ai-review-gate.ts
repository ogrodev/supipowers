import type { GateResult } from "../types.js";

export function buildAiReviewPrompt(
  changedFiles: string[],
  depth: "quick" | "deep"
): string {
  const depthInstructions =
    depth === "quick"
      ? "Do a quick scan: check for obvious bugs, security issues, and naming problems."
      : [
          "Do a thorough review covering:",
          "- Correctness and edge cases",
          "- Security vulnerabilities (OWASP top 10)",
          "- Performance concerns",
          "- Code clarity and maintainability",
          "- Error handling completeness",
          "- Test coverage gaps",
        ].join("\n");

  return [
    "Review the following changed files:",
    ...changedFiles.map((f) => `- ${f}`),
    "",
    depthInstructions,
    "",
    "For each issue found, report:",
    "- Severity: error | warning | info",
    "- File and line number",
    "- Description of the issue",
    "- Suggested fix",
  ].join("\n");
}

export function createAiReviewResult(
  issues: { severity: "error" | "warning" | "info"; message: string; file?: string; line?: number }[]
): GateResult {
  const hasErrors = issues.some((i) => i.severity === "error");
  return {
    gate: "ai-review",
    passed: !hasErrors,
    issues,
  };
}
