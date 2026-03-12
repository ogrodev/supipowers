import type { QaSessionLedger } from "../../types.js";

export function buildReportingPrompt(ledger: QaSessionLedger): string {
  const passed = ledger.results.filter((r) => r.status === "pass").length;
  const failed = ledger.results.filter((r) => r.status === "fail").length;
  const skipped = ledger.results.filter((r) => r.status === "skip").length;
  const total = ledger.results.length;

  const failedList = ledger.results
    .filter((r) => r.status === "fail")
    .map((r) => {
      const test = ledger.tests.find((t) => t.id === r.testId);
      return `- ${test?.testName ?? r.testId}: ${r.error ?? "no error captured"}`;
    })
    .join("\n");

  const matrixSummary = ledger.matrix.length > 0
    ? ledger.matrix
        .map((m) => `- ${m.requirement}: ${m.coverage} coverage (${m.testIds.length} tests)`)
        .join("\n")
    : "No traceability matrix available.";

  const sections: string[] = [
    "# QA Phase: Reporting",
    "",
    `Framework: ${ledger.framework}`,
    `Session: ${ledger.id}`,
    "",
    "## Execution Summary",
    "",
    `- Total: ${total}`,
    `- Passed: ${passed}`,
    `- Failed: ${failed}`,
    `- Skipped: ${skipped}`,
    `- Pass rate: ${total > 0 ? Math.round((passed / total) * 100) : 0}%`,
    "",
  ];

  if (failed > 0) {
    sections.push("## Failed Tests", "", failedList, "");
  }

  sections.push(
    "## Traceability Matrix",
    "",
    matrixSummary,
    "",
    "## Task",
    "",
    "Analyze the test results and traceability matrix above. Produce a QA report summary that includes:",
    "",
    "1. Overall assessment of test health",
    "2. Coverage gaps identified from the matrix",
    "3. Recommendations for improving coverage",
    "4. Risk areas where failures cluster",
    "",
    "## Expected Output",
    "",
    "Write a JSON object to the QA session ledger's `report` field:",
    "",
    "```json",
    `{ "generatedAt": "ISO timestamp", "total": ${total}, "passed": ${passed}, "failed": ${failed}, "skipped": ${skipped}, "passRate": ${total > 0 ? Math.round((passed / total) * 100) : 0}, "failedTests": [...], "coverageSummary": "free-text analysis" }`,
    "```",
    "",
    "## After Completion",
    "",
    "Update the QA session ledger with the report, mark the reporting phase as completed. The QA pipeline is now complete.",
  );

  return sections.join("\n");
}
