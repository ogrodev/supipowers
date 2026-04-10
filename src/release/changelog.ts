// src/release/changelog.ts — Conventional commit parsing and changelog generation

import type { CategorizedCommits, CommitEntry } from "../types.js";
import { normalizeLineEndings } from "../text.js";
import { IMPROVEMENT_TYPES, MAINTENANCE_TYPES, type ConventionalCommitType } from "./commit-types.js";

// Matches: feat(scope)!: message  or  feat!: message  or  feat(scope): message  or  feat: message
// Capture groups: (1) type, (2) scope|undefined, (3) breaking bang|undefined, (4) message
const CONVENTIONAL_PREFIX =
  /^([a-z]+)(?:\(([^)]+)\))?(!)?:\s+(.+)$/;

// `BREAKING CHANGE:` and `BREAKING-CHANGE:` anywhere in the message line
const BREAKING_CHANGE_FOOTER = /BREAKING[- ]CHANGE:/;

/**
 * Parse a single `git log --oneline` line into hash + raw message.
 * Returns null for blank lines or lines too short to contain a real hash.
 */
function parseLine(line: string): { hash: string; raw: string } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) return null; // hash with no message

  const hash = trimmed.slice(0, spaceIdx);
  const raw = trimmed.slice(spaceIdx + 1).trim();
  if (!raw) return null;

  return { hash, raw };
}

/**
 * Parse a multiline `git log --oneline` string into categorized commit entries.
 *
 * Lines that match BREAKING CHANGE footer notation are placed in `breaking`
 * regardless of their type prefix.  A `feat!:` commit lands in both `breaking`
 * AND `features` — the breaking array is the source of truth for what changed
 * the contract; the features array ensures it still shows up in release notes.
 */

export function parseConventionalCommits(gitLog: string): CategorizedCommits {
  const normalizedGitLog = normalizeLineEndings(gitLog);
  const result: CategorizedCommits = {
    features: [],
    fixes: [],
    breaking: [],
    improvements: [],
    maintenance: [],
    other: [],
  };

  for (const line of normalizedGitLog.split("\n")) {
    const parsed = parseLine(line);
    if (!parsed) continue;

    const { hash, raw } = parsed;

    // Check for footer-style breaking change notation first (takes priority over type)
    if (BREAKING_CHANGE_FOOTER.test(raw)) {
      result.breaking.push({ hash, message: raw });
      continue;
    }

    const match = CONVENTIONAL_PREFIX.exec(raw);
    if (!match) {
      result.other.push({ hash, message: raw });
      continue;
    }

    const [, type, scope, bang, message] = match;
    const entry: CommitEntry = { hash, message, type, ...(scope ? { scope } : {}) };
    const isBreaking = bang === "!";

    // Route to the correct bucket based on conventional commit type
    let bucket: CommitEntry[];
    if (type === "feat") {
      bucket = result.features;
    } else if (type === "fix") {
      bucket = result.fixes;
    } else if (IMPROVEMENT_TYPES.has(type as ConventionalCommitType)) {
      bucket = result.improvements;
    } else if (MAINTENANCE_TYPES.has(type as ConventionalCommitType)) {
      bucket = result.maintenance;
    } else {
      bucket = result.other;
    }

    if (isBreaking) result.breaking.push({ ...entry });
    bucket.push(entry);
  }

  return result;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatEntry(entry: CommitEntry): string {
  const scopePart = entry.scope ? ` (${entry.scope})` : "";
  return `- ${entry.message}${scopePart} \`${entry.hash}\``;
}

/**
 * Build a markdown changelog block for the given version.
 * Empty sections are omitted entirely.
 */
export function buildChangelogMarkdown(
  commits: CategorizedCommits,
  version: string
): string {
  const lines: string[] = [];

  lines.push(`## v${version}`);
  lines.push(`_${isoDate(new Date())}_`);
  lines.push("");

  const sections: [string, CommitEntry[]][] = [
    ["### \u{1F6A8} Breaking Changes", commits.breaking],
    ["### \u{2728} Features", commits.features],
    ["### \u{1F41B} Fixes", commits.fixes],
    ["### \u{1F527} Improvements", commits.improvements],
    ["### \u{1F3D7}\uFE0F Maintenance", commits.maintenance],
    ["### \u{1F4E6} Other", commits.other],
  ];

  let firstSection = true;
  for (const [header, entries] of sections) {
    if (entries.length === 0) continue;
    if (!firstSection) lines.push("");
    firstSection = false;

    lines.push(header);
    lines.push("");
    for (const entry of entries) {
      lines.push(formatEntry(entry));
    }
  }

  return lines.join("\n");
}

/**
 * Return a one-line human summary of the commit distribution.
 * Zero-count categories are omitted; all-empty returns "no changes found".
 */
export function summarizeChanges(commits: CategorizedCommits): string {
  const parts: string[] = [];

  const { features, fixes, breaking, improvements, maintenance } = commits;

  if (features.length > 0) {
    parts.push(`${features.length} feature${features.length === 1 ? "" : "s"}`);
  }
  if (fixes.length > 0) {
    parts.push(`${fixes.length} fix${fixes.length === 1 ? "" : "es"}`);
  }
  if (improvements.length > 0) {
    parts.push(`${improvements.length} improvement${improvements.length === 1 ? "" : "s"}`);
  }
  if (maintenance.length > 0) {
    parts.push(`${maintenance.length} maintenance`);
  }
  if (breaking.length > 0) {
    parts.push(
      `${breaking.length} breaking change${breaking.length === 1 ? "" : "s"}`
    );
  }

  // other is intentionally omitted from the summary — it's noise

  if (parts.length === 0) return "no changes found";
  return parts.join(", ");
}
