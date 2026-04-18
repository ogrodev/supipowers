import { formatTag } from "./version.js";
import { renderSchemaText } from "../ai/schema-text.js";
import { ReleaseNotePolishOutputSchema } from "./contracts.js";

export interface BuildPolishPromptOpts {
  changelog: string;
  version: string;
  tagFormat?: string;
}

/**
 * Build a prompt for a headless agent session that polishes raw changelog
 * text into clear, user-facing release notes.
 *
 * The agent returns a structured JSON artifact matching
 * ReleaseNotePolishOutputSchema. The release command renders the polished
 * changelog from that artifact — no free-form text, no regex extraction.
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
    `You are polishing changelog notes for **${formatTag(version, opts.tagFormat ?? "v${version}")}**.`,
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
    "Respond with a JSON object that matches this TypeScript shape exactly:",
    "",
    "```ts",
    renderSchemaText(ReleaseNotePolishOutputSchema),
    "```",
    "",
    "Field guide:",
    "- `title`: short one-line heading for the release (no leading `#`).",
    "- `body`: the grouped markdown sections (Breaking Changes, Features, Fixes, ...). Omit empty sections.",
    "- `highlights`: 0–5 short bullet strings summarising the most user-visible changes. Each string is a plain sentence, no leading `-`.",
    "- `status`: `\"ok\"` when the release has notable changes; `\"empty\"` when the raw changelog had nothing worth polishing (highlights may be empty and body may be a short placeholder).",
    "",
    "Respond with only the JSON object. You may wrap it in a ```json fence.",
  ].join("\n");
}
