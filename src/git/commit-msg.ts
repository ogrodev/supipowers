// src/git/commit-msg.ts — Commit message validation against conventional commit format

import { VALID_COMMIT_TYPES } from "../release/commit-types.js";
import { normalizeLineEndings } from "../text.js";

// Same regex shape as changelog.ts CONVENTIONAL_PREFIX
const CONVENTIONAL_RE = /^([a-z]+)(?:\(([^)]+)\))?(!)?:\s+(.+)$/;

// Messages that bypass conventional commit validation (git-generated or interactive rebase)
const BYPASS_PREFIXES = [
  "Merge ",
  'Revert "',
  "fixup! ",
  "squash! ",
  "amend! ",
];

export interface CommitValidation {
  valid: boolean;
  error?: string;
}

export function validateCommitMessage(message: string): CommitValidation {
  const firstLine = normalizeLineEndings(message).split("\n")[0].trim();

  if (!firstLine) {
    return { valid: false, error: "Commit message is empty." };
  }

  // Allow through special git-generated messages
  if (BYPASS_PREFIXES.some((p) => firstLine.startsWith(p))) {
    return { valid: true };
  }

  const match = CONVENTIONAL_RE.exec(firstLine);
  if (!match) {
    return {
      valid: false,
      error:
        `Commit message does not match conventional format: type(scope)?: message\n` +
        `Valid types: ${VALID_COMMIT_TYPES.join(", ")}`,
    };
  }

  const [, type] = match;
  if (!(VALID_COMMIT_TYPES as readonly string[]).includes(type)) {
    return {
      valid: false,
      error: `Unknown commit type "${type}".\nValid types: ${VALID_COMMIT_TYPES.join(", ")}`,
    };
  }

  return { valid: true };
}
