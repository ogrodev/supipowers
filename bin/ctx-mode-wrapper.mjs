#!/usr/bin/env node
// Wrapper for context-mode MCP server that preserves the project directory.
// OMP launches MCP servers with cwd set to the project directory, but
// context-mode's start.mjs immediately does process.chdir(__dirname),
// losing the project path. This wrapper captures cwd first.

import { resolve } from "node:path";

// Capture the real project directory BEFORE start.mjs clobbers it
const projectDir = resolve(process.cwd());
process.env.CLAUDE_PROJECT_DIR = projectDir;

// Resolve start.mjs path from the first CLI argument
const startMjs = process.argv[2];
if (!startMjs) {
  process.stderr.write("ctx-mode-wrapper: missing start.mjs path argument\n");
  process.exit(1);
}

// Dynamic import to run start.mjs
await import(startMjs);
