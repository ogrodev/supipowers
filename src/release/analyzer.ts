/** Build prompt to analyze commits and suggest version bump */
export function buildAnalyzerPrompt(lastTag: string | null): string {
  const sinceArg = lastTag ? `${lastTag}..HEAD` : "HEAD~20..HEAD";
  return [
    "# Release Analysis",
    "",
    `Analyze commits since ${lastTag ?? "beginning"}.`,
    "",
    `Run: git log ${sinceArg} --oneline --no-decorate`,
    "",
    "Then determine:",
    "1. Version bump type: major (breaking changes), minor (new features), patch (fixes)",
    "2. Categorize commits: features, fixes, breaking changes, other",
    "3. Suggest the next version number",
    "",
    "Report in this format:",
    "- Current version: <from package.json or last tag>",
    "- Suggested bump: major|minor|patch",
    "- Next version: X.Y.Z",
    "- Changes summary: categorized list",
  ].join("\n");
}
