#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const isWindows = process.platform === "win32";
const __dirname = dirname(fileURLToPath(import.meta.url));

const userArgs = process.argv.slice(2);
const subcommand = userArgs[0];

let script;
let scriptArgs;

if (subcommand === "migrate") {
  // `bunx supipowers migrate [...]` — execution-state migration.
  script = join(__dirname, "migrate.ts");
  scriptArgs = userArgs.slice(1);
} else {
  // Default: installer flow. When invoked via bunx/npx, always force a full
  // install to guarantee node_modules/ and a consistent extension directory.
  // The --force flag bypasses the "already up to date" version check.
  script = join(__dirname, "install.ts");
  scriptArgs = ["--force", ...userArgs];
}

const result = spawnSync("bun", [script, ...scriptArgs], {
  stdio: "inherit",
  env: process.env,
  shell: isWindows,
});
process.exit(result.status ?? 1);
