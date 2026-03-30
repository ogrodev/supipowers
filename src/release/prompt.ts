import type { ReleaseChannel } from "../types.js";

export interface BuildPolishPromptOpts {
  changelog: string;
  version: string;
  currentVersion: string;
  channels: ReleaseChannel[];
  commands: string[];
}

/**
 * Build a steer prompt that instructs the LLM to polish the pre-built changelog,
 * present it to the user for confirmation, then run the release commands on approval.
 */
export function buildPolishPrompt(opts: BuildPolishPromptOpts): string {
  const { changelog, version, currentVersion, channels, commands } = opts;

  const channelList = channels.map((c) => `- ${c}`).join("\n");
  const commandList = commands.map((c) => `- \`${c}\``).join("\n");

  const changelogSection =
    changelog.trim().length > 0
      ? changelog.trim()
      : "_No notable changes in this release._";

  return [
    "# Release Polish & Confirmation",
    "",
    `You are preparing a release of **${version}** (from ${currentVersion}).`,
    "",
    "## Target Channels",
    "",
    channelList,
    "",
    "## Pre-built Changelog",
    "",
    "The following changelog was generated from commits. It is raw and may contain",
    "terse commit-message language.",
    "",
    changelogSection,
    "",
    "## Your Task",
    "",
    "1. **Polish** the changelog above into clear, user-facing language:",
    "   - Rewrite terse commit descriptions into plain English a user would understand.",
    "   - Group closely related changes together under the same bullet.",
    "   - Remove noise (chores, reformats, typo fixes) unless they fix a user-visible bug.",
    "   - Do **not** change version numbers.",
    "   - Do **not** skip or reorder the section headings (Features, Fixes, Breaking Changes).",
    "   - Do **not** invent changes that are not in the raw changelog.",
    "",
    "2. **Present** the polished changelog to the user in a readable format.",
    "",
    "3. **Ask** the user for confirmation:",
    '   > "Does this look good? Type **yes** to proceed with the release, or **no** to abort."',
    "",
    "## On Approval",
    "",
    "If the user confirms, run the following commands **in order** without modification:",
    "",
    commandList,
    "",
    "Do **not** skip any command. Do **not** modify the commands.",
    "Report the result of each command as it completes.",
    "",
    "## On Rejection",
    "",
    "If the user rejects, abort the release immediately.",
    "Inform the user: _Release aborted. No changes were made._",
  ].join("\n");
}
