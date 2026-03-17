#!/usr/bin/env node
// Wrapper for context-mode MCP server that preserves the project directory.
// OMP launches MCP servers with cwd set to the project directory, but
// context-mode's start.mjs immediately does process.chdir(__dirname),
// losing the project path. This wrapper captures cwd first.
//
// Setting CLAUDE_PROJECT_DIR causes start.mjs to also write a CLAUDE.md
// in the project root. This is harmless (OMP doesn't read it) but the
// user should gitignore it. We also write .omp/SYSTEM.md with routing
// rules since that's what OMP actually loads as system prompt.

import { resolve, join, dirname } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __wrapperDir = dirname(fileURLToPath(import.meta.url));

// Capture the real project directory BEFORE start.mjs clobbers it
const projectDir = resolve(process.cwd());
process.env.CLAUDE_PROJECT_DIR = projectDir;

// Note: context-mode uses per-PID ephemeral FTS5 databases that are cleaned
// up on process exit. Within a session, indexed content persists and ctx_search
// can query it. Across sessions, content must be re-indexed.
// The SKILL.md routing rules emphasize using ctx_search for follow-ups.

// Resolve start.mjs path from the first CLI argument
const startMjs = process.argv[2];
if (!startMjs) {
  process.stderr.write("ctx-mode-wrapper: missing start.mjs path argument\n");
  process.exit(1);
}

// Write .omp/SYSTEM.md with routing rules (idempotent — only if marker absent)
const ROUTING_MARKER = "# context-mode — MANDATORY routing rules";
try {
  // Find SKILL.md from multiple possible locations
  const skillCandidates = [
    join(homedir(), ".omp", "agent", "skills", "context-mode", "SKILL.md"),
    join(__wrapperDir, "..", "skills", "context-mode", "SKILL.md"),
  ];
  let skillContent = null;
  for (const candidate of skillCandidates) {
    try { skillContent = readFileSync(candidate, "utf-8"); break; } catch { /* next */ }
  }

  if (skillContent && skillContent.includes(ROUTING_MARKER)) {
    const ompDir = join(projectDir, ".omp");
    const systemMdPath = join(ompDir, "SYSTEM.md");

    if (!existsSync(ompDir)) mkdirSync(ompDir, { recursive: true });

    if (!existsSync(systemMdPath)) {
      writeFileSync(systemMdPath, skillContent);
    } else {
      const existing = readFileSync(systemMdPath, "utf-8");
      if (!existing.includes(ROUTING_MARKER)) {
        writeFileSync(systemMdPath, existing.trimEnd() + "\n\n" + skillContent);
      }
    }
  }
} catch { /* best effort — don't block server startup */ }

// Dynamic import to run start.mjs (server starts here)
await import(startMjs);
