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
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import os from "node:os";

const __wrapperDir = dirname(fileURLToPath(import.meta.url));

// Capture the real project directory BEFORE start.mjs clobbers it
const projectDir = resolve(process.cwd());
process.env.CLAUDE_PROJECT_DIR = projectDir;

// Redirect context-mode's FTS5 database to a project-scoped directory.
// ContentStore uses `join(tmpdir(), "context-mode-<pid>.db")`.
// By patching os.tmpdir, the DB lives in .omp/context-mode/ instead of /tmp/.
// We also copy the previous session's DB to the new PID filename so indexed
// content persists across sessions (context-mode creates per-PID filenames).
const ctxDbDir = join(projectDir, ".omp", "context-mode");
if (!existsSync(ctxDbDir)) mkdirSync(ctxDbDir, { recursive: true });

// Find the most recent existing DB and copy it for the new session
const currentDbName = `context-mode-${process.pid}.db`;
try {
  const existing = readdirSync(ctxDbDir)
    .filter(f => f.match(/^context-mode-\d+\.db$/) && f !== currentDbName);
  if (existing.length > 0) {
    // Pick the newest by mtime
    const newest = existing
      .map(f => ({ name: f, mtime: statSync(join(ctxDbDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0];
    if (newest) {
      copyFileSync(join(ctxDbDir, newest.name), join(ctxDbDir, currentDbName));
      // Also copy WAL/SHM if they exist
      for (const suffix of ["-wal", "-shm"]) {
        const src = join(ctxDbDir, newest.name + suffix);
        if (existsSync(src)) {
          copyFileSync(src, join(ctxDbDir, currentDbName + suffix));
        }
      }
    }
  }
} catch { /* best effort */ }

os.tmpdir = () => ctxDbDir;

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
