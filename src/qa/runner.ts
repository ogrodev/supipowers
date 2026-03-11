export function buildQaRunPrompt(
  command: string,
  scope: "all" | "changed" | "e2e",
  changedFiles?: string[]
): string {
  const sections: string[] = ["# QA Pipeline", ""];

  switch (scope) {
    case "all":
      sections.push(`Run the full test suite: \`${command}\``);
      break;
    case "changed":
      sections.push(
        "Run tests related to changed files only:",
        ...(changedFiles ?? []).map((f) => `- ${f}`),
        "",
        `Base command: \`${command}\``,
        "Filter to only tests relevant to the files above."
      );
      break;
    case "e2e":
      sections.push(
        "Run end-to-end tests only.",
        "Use Playwright or the configured E2E framework.",
        "Command: `npx playwright test`"
      );
      break;
  }

  sections.push(
    "",
    "Report results in this format:",
    "- Total tests: N",
    "- Passed: N",
    "- Failed: N",
    "- Skipped: N",
    "",
    "For each failure, include:",
    "- Test name",
    "- File path",
    "- Error message",
    "- Stack trace (first 5 lines)"
  );

  return sections.join("\n");
}
