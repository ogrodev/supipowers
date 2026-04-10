// src/git/conventions.ts — Discover commit message conventions from repo docs and config

import { readFileSync, existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

type ExecFn = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string },
) => Promise<{ stdout: string; code: number }>;

export interface CommitConventions {
  /** Concatenated relevant sections from repo docs */
  guidelines: string;
  /** Source files that were found */
  sources: string[];
}

/** Max total output size — prevents blowing up the agent prompt */
const MAX_GUIDELINES_BYTES = 4096;

/**
 * Discover commit conventions by scanning well-known files and config.
 * Pure I/O — reads filesystem and one git config query, no side effects.
 */
export async function discoverCommitConventions(
  exec: ExecFn,
  cwd: string,
): Promise<CommitConventions> {
  const sections: { source: string; content: string }[] = [];

  // ── Markdown docs (extract commit-related sections) ──────
  for (const file of ["CONTRIBUTING.md", "AGENTS.md"]) {
    const content = readFileSafe(join(cwd, file));
    if (content) {
      const extracted = extractCommitSections(content);
      if (extracted) {
        sections.push({ source: file, content: extracted });
      }
    }
  }

  // ── Dedicated commit convention files (read in full) ─────
  for (const file of ["COMMIT.md", "COMMIT_CONVENTIONS.md"]) {
    const content = readFileSafe(join(cwd, file));
    if (content) {
      sections.push({ source: file, content });
    }
  }

  // ── Commitlint config ────────────────────────────────────
  for (const file of [
    ".commitlintrc.json",
    ".commitlintrc.yml",
    ".commitlintrc.js",
  ]) {
    const content = readFileSafe(join(cwd, file));
    if (content) {
      sections.push({ source: file, content });
    }
  }

  // ── Commitizen config ────────────────────────────────────
  for (const file of [".czrc", ".cz.json"]) {
    const content = readFileSafe(join(cwd, file));
    if (content) {
      sections.push({ source: file, content });
    }
  }

  // ── package.json — commitlint / commitizen fields ────────
  const pkgContent = readFileSafe(join(cwd, "package.json"));
  if (pkgContent) {
    try {
      const pkg = JSON.parse(pkgContent);
      const relevant: Record<string, unknown> = {};
      if (pkg.commitlint) relevant.commitlint = pkg.commitlint;
      if (pkg.config?.commitizen) relevant["config.commitizen"] = pkg.config.commitizen;
      if (Object.keys(relevant).length > 0) {
        sections.push({
          source: "package.json",
          content: JSON.stringify(relevant, null, 2),
        });
      }
    } catch {
      // Malformed package.json — skip
    }
  }

  // ── Commit hooks ─────────────────────────────────────────
  for (const hookPath of [
    join(cwd, ".husky", "commit-msg"),
    join(cwd, ".git", "hooks", "commit-msg"),
  ]) {
    const content = readFileSafe(hookPath);
    if (content) {
      const relative = hookPath.startsWith(cwd)
        ? hookPath.slice(cwd.length + 1)
        : hookPath;
      sections.push({ source: relative, content });
    }
  }

  // ── Git commit template ──────────────────────────────────
  try {
    const result = await exec(
      "git",
      ["config", "commit.template"],
      { cwd },
    );
    if (result.code === 0 && result.stdout.trim()) {
      const templatePath = result.stdout.trim();
      const absPath = isAbsolute(templatePath)
        ? templatePath
        : join(cwd, templatePath);
      const content = readFileSafe(absPath);
      if (content) {
        sections.push({ source: `commit.template (${templatePath})`, content });
      }
    }
  } catch {
    // git config query failed — skip
  }

  // ── Assemble and truncate ────────────────────────────────
  if (sections.length === 0) {
    return { guidelines: "", sources: [] };
  }

  let guidelines = sections
    .map((s) => `### ${s.source}\n${s.content}`)
    .join("\n\n");

  if (Buffer.byteLength(guidelines, "utf8") > MAX_GUIDELINES_BYTES) {
    // Truncate by sections from the end until under limit
    while (
      sections.length > 1 &&
      Buffer.byteLength(guidelines, "utf8") > MAX_GUIDELINES_BYTES
    ) {
      sections.pop();
      guidelines = sections
        .map((s) => `### ${s.source}\n${s.content}`)
        .join("\n\n");
    }
    // If a single section is still too large, hard-truncate
    if (Buffer.byteLength(guidelines, "utf8") > MAX_GUIDELINES_BYTES) {
      guidelines = guidelines.slice(0, MAX_GUIDELINES_BYTES) + "\n[truncated]";
    }
  }

  return {
    guidelines,
    sources: sections.map((s) => s.source),
  };
}

// ── Helpers ──────────────────────────────────────────────────

function readFileSafe(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const content = readFileSync(path, "utf8");
    return content.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Extract markdown sections whose headings mention commit conventions.
 * Returns null if no relevant sections found.
 */
function extractCommitSections(markdown: string): string | null {
  const lines = markdown.split("\n");
  const HEADING_RE = /^(#{1,4})\s+(.+)$/;
  const KEYWORDS_RE = /commit|conventional|message format/i;

  const sections: string[] = [];
  let capturing = false;
  let captureLevel = 0;
  let buffer: string[] = [];

  for (const line of lines) {
    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const title = headingMatch[2];

      // If we were capturing, a same-or-higher-level heading ends the section
      if (capturing && level <= captureLevel) {
        sections.push(buffer.join("\n"));
        buffer = [];
        capturing = false;
      }

      if (KEYWORDS_RE.test(title)) {
        capturing = true;
        captureLevel = level;
        buffer.push(line);
        continue;
      }
    }

    if (capturing) {
      buffer.push(line);
    }
  }

  // Flush last section
  if (capturing && buffer.length > 0) {
    sections.push(buffer.join("\n"));
  }

  return sections.length > 0 ? sections.join("\n\n") : null;
}
