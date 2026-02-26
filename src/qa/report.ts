import type { QaCaseResult, QaExecutionSummary, QaVerdict } from "./types";

function classifyRecommendation(results: QaCaseResult[]): Exclude<QaVerdict, "PENDING_DECISION"> {
  const hasHighFailure = results.some((item) => !item.passed && item.severity === "high");
  if (hasHighFailure) return "REFUSE";

  const hasFailure = results.some((item) => !item.passed);
  return hasFailure ? "REFUSE" : "APPROVE";
}

function summarizeResultLine(result: QaCaseResult): string {
  const status = result.passed ? "✅ PASS" : "❌ FAIL";
  return `- ${status} ${result.caseId} (${result.severity}) — ${result.title}`;
}

function renderEvidence(result: QaCaseResult): string[] {
  if (result.screenshots.length === 0) return ["- (no screenshots captured)"];
  return result.screenshots.map((name) => `- screenshots/${name}`);
}

export function deriveQaRecommendation(results: QaCaseResult[]): Exclude<QaVerdict, "PENDING_DECISION"> {
  return classifyRecommendation(results);
}

export function buildQaFindingsReport(summary: QaExecutionSummary): string {
  const passCount = summary.results.filter((item) => item.passed).length;
  const failCount = summary.results.length - passCount;

  const lines: string[] = [
    `# QA Findings — ${summary.runId}`,
    "",
    `- Workflow: ${summary.workflow}`,
    `- Target URL: ${summary.targetUrl}`,
    `- Started at: ${summary.startedAt}`,
    `- Finished at: ${summary.finishedAt}`,
    `- Recommendation: ${summary.recommendation}`,
    `- Final verdict: ${summary.finalVerdict}`,
    `- Notes file: ${summary.notesFilePath}`,
  ];

  if (summary.unstablePhaseWarning) {
    lines.push(`- Stability warning: ${summary.unstablePhaseWarning}`);
  }

  lines.push("", "## Summary", "");
  lines.push(`- Total cases: ${summary.results.length}`);
  lines.push(`- Passed: ${passCount}`);
  lines.push(`- Failed: ${failCount}`);

  lines.push("", "## Case outcomes", "");
  summary.results.forEach((result) => {
    lines.push(summarizeResultLine(result));
    if (result.error) lines.push(`  - Error: ${result.error}`);
  });

  lines.push("", "## Evidence", "");
  summary.results.forEach((result) => {
    lines.push(`### ${result.caseId}`);
    lines.push(...renderEvidence(result));
    lines.push("");
  });

  lines.push("## Recommendation rationale", "");
  if (summary.recommendation === "APPROVE") {
    lines.push("All tracked QA cases passed. Approve release from QA perspective.");
  } else {
    lines.push("At least one QA case failed. Refuse approval until issues are addressed and rerun.");
  }

  if (summary.finalVerdict === "PENDING_DECISION") {
    lines.push("", "## Final decision", "", "Decision is pending manual confirmation.");
  }

  return `${lines.join("\n")}\n`;
}
