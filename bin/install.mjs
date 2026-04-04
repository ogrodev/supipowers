#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const isWindows = process.platform === "win32";
const __dirname = dirname(fileURLToPath(import.meta.url));
// When invoked via bunx/npx, always force a full install to guarantee
// node_modules/ and a consistent extension directory. The --force flag
// bypasses the "already up to date" version check.
const args = [join(__dirname, "install.ts"), "--force", ...process.argv.slice(2)];
const result = spawnSync("bun", args, {
  stdio: "inherit",
  env: process.env,
  shell: isWindows,
});
process.exit(result.status ?? 1);
