/** Build prompt to generate release notes */
export function buildNotesPrompt(version: string, lastTag: string | null): string {
  const sinceArg = lastTag ? `${lastTag}..HEAD` : "HEAD~20..HEAD";
  return [
    "# Generate Release Notes",
    "",
    `Version: ${version}`,
    "",
    `Run: git log ${sinceArg} --format="%h %s"`,
    "",
    "Generate release notes in this format:",
    "",
    `## ${version}`,
    "",
    "### Features",
    "- Description (commit hash)",
    "",
    "### Fixes",
    "- Description (commit hash)",
    "",
    "### Breaking Changes",
    "- Description (commit hash)",
    "",
    "Keep descriptions user-facing (not commit-message-level detail).",
  ].join("\n");
}
