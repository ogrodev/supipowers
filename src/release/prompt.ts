export interface BuildPolishPromptOpts {
  changelog: string;
  version: string;
}

/**
 * Build a prompt for a headless agent session that polishes raw changelog
 * text into clear, user-facing release notes.
 *
 * The agent returns only the polished markdown — no commands, no confirmation.
 */
export function buildPolishPrompt(opts: BuildPolishPromptOpts): string {
  const { changelog, version } = opts;

  const changelogSection =
    changelog.trim().length > 0
      ? changelog.trim()
      : "_No notable changes in this release._";

  return [
    "# Polish Release Notes",
    "",
    `You are polishing changelog notes for **v${version}**.`,
    "",
    "## Raw Changelog",
    "",
    changelogSection,
    "",
    "## Instructions",
    "",
    "Rewrite the raw changelog above into clear, user-facing release notes:",
    "- Rewrite terse commit descriptions into plain English a user would understand.",
    "- Group closely related changes together under the same bullet.",
    "- Remove noise (chores, reformats, typo fixes) unless they fix a user-visible bug.",
    "- Do **not** change version numbers.",
    "- Do **not** skip or reorder the section headings (Breaking Changes, Features, Fixes, Improvements, Maintenance, Other). Omit empty sections.",
    "- Do **not** invent changes that are not in the raw changelog.",
    "",
    "## Output",
    "",
    "Return **only** the polished markdown changelog. No preamble, no explanation, no code fences wrapping the whole output.",
  ].join("\n");
}
