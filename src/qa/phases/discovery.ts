import type { DetectedFramework } from "../detector.js";

export function buildDiscoveryPrompt(framework: DetectedFramework, cwd: string): string {
  const sections: string[] = [
    "# QA Phase: Test Discovery",
    "",
    `Project: ${cwd}`,
    `Test framework: ${framework.name} (command: \`${framework.command}\`)`,
    "",
    "## Task",
    "",
    "Scan the project for all test files and enumerate every individual test case.",
    "",
    "1. Find all test files matching the framework's conventions",
    "2. Parse each file to extract individual test/it/describe blocks",
    "3. Classify each test with tags (unit, integration, e2e) based on file path or naming",
    "",
    "## Expected Output",
    "",
    "Write a JSON array to the QA session ledger's `tests` field. Each entry:",
    "",
    "```json",
    '[{ "id": "<filePath>:<testName>", "filePath": "relative/path.test.ts", "testName": "test name", "suiteName": "describe block", "tags": ["unit"] }]',
    "```",
    "",
    "The `id` must be deterministic: use `filePath:testName` so it stays stable across sessions.",
    "",
    "## After Completion",
    "",
    "Update the QA session ledger with the discovered tests, mark the discovery phase as completed, then invoke `/supi:qa` to continue to the next phase.",
  ];

  return sections.join("\n");
}
