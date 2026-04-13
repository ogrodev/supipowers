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
    "Rewrite the raw changelog above into clear, user-facing release notes.",
    "",
    "### Content rules",
    "",
    "| Rule | Details |",
    "|------|---------|",
    "| Plain English | Rewrite terse commit descriptions so a user understands the impact |",
    "| Group related | Merge closely related changes into a single bullet |",
    "| Remove noise | Drop chores, reformats, typo fixes — unless they fix a user-visible bug |",
    "| No invented changes | Every bullet must trace back to the raw changelog |",
    "| Preserve headings | Keep section order: Breaking Changes, Features, Fixes, Improvements, Maintenance, Other. Omit empty sections |",
    "| Preserve versions | Do **not** change version numbers |",
    "",
    "### Superseded changes",
    "",
    "Drop entries whose effect is entirely negated or replaced by a later entry in the same release.",
    "",
    "Detect these patterns:",
    "- **Replaced**: feature A is added, then later replaced by feature B → keep only B.",
    "- **Reverted**: a change is introduced and then reverted → drop both.",
    "- **Evolved**: an item is added, then renamed/rewritten → keep only the final form.",
    "",
    "The changelog describes the **net state** of the release — what a user upgrading from the previous version actually gets — not the development history that produced it.",
    "",
    "```",
    "before (wrong):",
    "- Added caching layer for API responses",
    "- Replaced caching layer with Redis-backed store",
    "",
    "after (correct):",
    "- Added Redis-backed caching for API responses",
    "```",
    "",
    "## Output",
    "",
    "Return **only** the polished markdown changelog. No preamble, no explanation, no code fences wrapping the whole output.",
  ].join("\n");
}
