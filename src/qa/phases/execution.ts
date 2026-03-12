import type { QaSessionLedger, QaTestCase } from "../../types.js";

export interface ExecutionOptions {
  failedOnly: true;
  failedTests: QaTestCase[];
}

export function buildExecutionPrompt(
  ledger: QaSessionLedger,
  options?: ExecutionOptions
): string {
  const isRetry = options?.failedOnly === true;
  const targetTests = isRetry ? options.failedTests : ledger.tests;

  const testList = targetTests
    .map((t) => `- ${t.id}: ${t.testName} (${t.filePath})`)
    .join("\n");

  const sections: string[] = [
    "# QA Phase: Test Execution",
    "",
    `Framework: ${ledger.framework}`,
  ];

  if (isRetry) {
    sections.push(
      "",
      `## Re-running ${targetTests.length} failed test(s)`,
      "",
      "Run ONLY the following failed tests:",
      "",
      testList,
    );
  } else {
    sections.push(
      "",
      `## Running all ${targetTests.length} test(s)`,
      "",
      testList,
    );
  }

  sections.push(
    "",
    "## Instructions",
    "",
    "1. Run the tests using the framework's CLI",
    "2. Collect per-test results: pass, fail, or skip",
    "3. For failures, capture the error message",
    "",
    "## Expected Output",
    "",
    "Write a JSON array to the QA session ledger's `results` field:",
    "",
    "```json",
    '[{ "testId": "file.test.ts:test name", "status": "pass|fail|skip", "duration": 123, "error": "only if failed" }]',
    "```",
    "",
    "## After Completion",
    "",
    "Update the QA session ledger with results, mark the execution phase as completed, then invoke `/supi:qa` to continue to the next phase.",
  );

  return sections.join("\n");
}
