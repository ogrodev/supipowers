#!/usr/bin/env bun
// src/git/commit-msg-hook.ts — CLI entry point for the commit-msg git hook

import { readFileSync } from "fs";
import { validateCommitMessage } from "./commit-msg.js";

const msgFile = process.argv[2];
if (!msgFile) {
  console.error("Usage: commit-msg-hook.ts <commit-msg-file>");
  process.exit(1);
}

const message = readFileSync(msgFile, "utf-8");
const result = validateCommitMessage(message);

if (!result.valid) {
  console.error(`\n❌ Invalid commit message:\n\n  ${result.error}\n`);
  console.error(`Example: feat(auth): add token refresh`);
  console.error(`Example: fix: handle null pointer in parser\n`);
  process.exit(1);
}
