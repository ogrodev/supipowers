import type { QaSessionLedger } from "../../types.js";

export function buildMatrixPrompt(ledger: QaSessionLedger): string {
  const testSummary = ledger.tests
    .map((t) => `- ${t.id}: ${t.testName} (${t.filePath})${t.tags ? ` [${t.tags.join(", ")}]` : ""}`)
    .join("\n");

  const sections: string[] = [
    "# QA Phase: Traceability Matrix",
    "",
    `Framework: ${ledger.framework}`,
    `Discovered tests: ${ledger.tests.length}`,
    "",
    "## Discovered Tests",
    "",
    testSummary,
    "",
    "## Task",
    "",
    "Build a traceability matrix that maps requirements to test cases and platforms.",
    "",
    "1. Read the project's README, PR descriptions, code comments, and doc files to identify requirements",
    "2. Map each requirement to the test case IDs that cover it",
    "3. Identify target platforms (node, browser, CI) from project config",
    "4. Assess coverage: full (all paths tested), partial (some paths), none (no tests)",
    "",
    "## Expected Output",
    "",
    "Write a JSON array to the QA session ledger's `matrix` field:",
    "",
    "```json",
    '[{ "requirement": "User login validates email format", "testIds": ["auth.test.ts:validates email"], "platforms": ["node"], "coverage": "full" }]',
    "```",
    "",
    "## After Completion",
    "",
    "Update the QA session ledger with the matrix, mark the matrix phase as completed, then invoke `/supi:qa` to continue to the next phase.",
  ];

  return sections.join("\n");
}
