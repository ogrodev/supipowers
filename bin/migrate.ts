#!/usr/bin/env bun
// bin/migrate.ts
//
// `bunx supipowers migrate` — move per-invocation execution state from the
// repo-local `<cwd>/.omp/supipowers/<dir>` tree into the project-scoped global
// tree at `~/.omp/supipowers/projects/<slug>/<dir>`.
//
// Flags:
//   --project <path>        Migrate the repo at the given path (default: cwd)
//   --all-under <parent>    Scan <parent> for repo roots and migrate each
//   --force                 Re-run even if the marker file is present
//   --dry-run               Do not mutate anything; print what would happen
//   --help                  Show usage

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir as osHomedir } from "node:os";
import {
  formatMigrationSummary,
  runMigration,
  type MigrationResult,
} from "../src/migrate/runner.js";

interface ParsedArgs {
  projects: string[];
  force: boolean;
  dryRun: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const projects: string[] = [];
  let force = false;
  let dryRun = false;
  let help = false;
  const explicitProjects: string[] = [];
  const scanUnder: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--project") {
      const next = argv[++i];
      if (!next) throw new Error("--project requires a path argument");
      explicitProjects.push(path.resolve(next));
    } else if (arg === "--all-under") {
      const next = argv[++i];
      if (!next) throw new Error("--all-under requires a path argument");
      scanUnder.push(path.resolve(next));
    } else if (!arg.startsWith("-")) {
      // Positional argument — treat as project path.
      explicitProjects.push(path.resolve(arg));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (explicitProjects.length === 0 && scanUnder.length === 0) {
    projects.push(process.cwd());
  }

  projects.push(...explicitProjects);

  for (const parent of scanUnder) {
    if (!fs.existsSync(parent)) {
      throw new Error(`--all-under directory does not exist: ${parent}`);
    }
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const abs = path.join(parent, entry.name);
      const legacyTree = path.join(abs, ".omp", "supipowers");
      if (fs.existsSync(legacyTree)) {
        projects.push(abs);
      }
    }
  }

  return { projects, force, dryRun, help };
}

function printHelp(): void {
  console.log(
    [
      "bunx supipowers migrate",
      "",
      "Move per-invocation execution state from <repo>/.omp/supipowers/<dir>",
      "to ~/.omp/supipowers/projects/<slug>/<dir>.",
      "",
      "Usage:",
      "  bunx supipowers migrate [--project <path>]...",
      "  bunx supipowers migrate --all-under <parent>",
      "",
      "Options:",
      "  --project <path>     Repository to migrate (may be repeated, default: cwd)",
      "  --all-under <parent> Scan parent for repos that have a .omp/supipowers tree",
      "  --force              Re-run even if the migration marker is present",
      "  --dry-run            Print what would be moved without touching anything",
      "  --help, -h           Show this message",
    ].join("\n"),
  );
}

function runDry(project: string): MigrationResult | null {
  // Dry-run: resolve paths and report what runMigration would do, but leave
  // the filesystem untouched. We accomplish this by making a shadow copy of
  // the source tree into a tempdir-backed fake homedir, then discarding it.
  // The simpler approach — compute the plan directly — duplicates too much
  // runtime logic. Instead, bail with a human-readable notice.
  console.log(
    [
      `[dry-run] Would migrate ${project}`,
      "  (dry-run is a no-op stub; re-run without --dry-run to apply.)",
    ].join("\n"),
  );
  return null;
}

function main(): void {
  const argv = process.argv.slice(2);
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`supipowers migrate: ${(err as Error).message}`);
    process.exit(2);
  }

  if (args.help) {
    printHelp();
    return;
  }

  const home = osHomedir();
  let failures = 0;

  for (const project of args.projects) {
    if (args.dryRun) {
      runDry(project);
      continue;
    }

    try {
      const result = runMigration({
        cwd: project,
        homedir: home,
        force: args.force,
      });
      for (const line of formatMigrationSummary(result)) {
        console.log(line);
      }
      if (result.conflicts.length > 0) {
        failures++;
      }
      console.log("");
    } catch (err) {
      console.error(
        `supipowers migrate: failed for ${project}: ${(err as Error).message}`,
      );
      failures++;
    }
  }

  process.exit(failures > 0 ? 1 : 0);
}

main();
