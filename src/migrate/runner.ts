// src/migrate/runner.ts
//
// Execution-state migration engine: moves per-invocation artifacts from the
// legacy repo-local tree (`<repoRoot>/.omp/supipowers/<dir>`) into the
// project-scoped global tree (`<homedir>/.omp/supipowers/projects/<slug>/<dir>`).
//
// Contracts:
// - Fail-closed on conflicts. If both source and destination exist, leave both
//   in place and surface the conflict. We never merge silently.
// - Idempotent. A marker file in the repo-local tree records completed runs;
//   subsequent invocations are no-ops unless `force` is set.
// - Hot-DB safe. SQLite databases under `sessions/` are not moved while
//   WAL/SHM sidecars are non-empty (indicates a live connection).
// - Workspace-aware. Mirrors under `workspaces/<rel>/` are walked so every
//   workspace target's execution state is migrated too.

import * as fs from "node:fs";
import * as path from "node:path";
import { projectSlugFromRepoRoot } from "../workspace/project-slug.js";
import { resolveRepoIdentityRootFromFs } from "../workspace/repo-root.js";

/** Execution-state directories/files that moved to the project-scoped global tree. */
export const EXECUTION_STATE_ENTRIES = [
  "plans",
  "reviews",
  "reports",
  "fix-pr-sessions",
  "qa-sessions",
  "reliability",
  "debug",
  "visual",
  "ui-design",
  "sessions",
  "doc-drift.json",
] as const;

export type MigrationEntryStatus = "moved" | "skipped" | "conflict" | "hot-db";

export interface MigrationEntryResult {
  rel: string;
  source: string;
  dest: string;
  status: MigrationEntryStatus;
  reason?: string;
}

export interface MigrationResult {
  repoRoot: string;
  slug: string;
  markerPath: string;
  moved: MigrationEntryResult[];
  skipped: MigrationEntryResult[];
  conflicts: MigrationEntryResult[];
  /** All per-entry results, including workspace mirrors. */
  entries: MigrationEntryResult[];
  /** Whether the marker file was written. */
  markerWritten: boolean;
  /** True when the marker already existed and migration was skipped as a no-op. */
  alreadyMigrated: boolean;
}

export interface MigrationOptions {
  /** Path inside a repo to migrate. Resolves to the repo identity root. */
  cwd: string;
  /** Home dir whose `<home>/.omp/supipowers` tree receives the moved state. */
  homedir: string;
  /** Re-run even if the marker file is present. */
  force?: boolean;
}

export const MIGRATION_MARKER_FILENAME = ".migration-v2.json";
export const MIGRATION_SCHEMA_VERSION = 2;

const WORKSPACES_DIR = "workspaces";
const SUPIPOWERS_DIR = "supipowers";
const DOT_DIR = ".omp";
const PROJECTS_DIR = "projects";

function legacyRoot(repoRoot: string): string {
  return path.join(repoRoot, DOT_DIR, SUPIPOWERS_DIR);
}

function globalProjectDir(homedir: string, slug: string): string {
  return path.join(homedir, DOT_DIR, SUPIPOWERS_DIR, PROJECTS_DIR, slug);
}

/**
 * Walk `<repoRoot>/.omp/supipowers/workspaces/...` and yield every workspace
 * subdirectory as a relative path like `workspaces/packages/api`.
 */
function discoverWorkspaceMirrors(repoRoot: string): string[] {
  const workspacesDir = path.join(legacyRoot(repoRoot), WORKSPACES_DIR);
  if (!fs.existsSync(workspacesDir)) return [];

  const results: string[] = [];
  const stack: Array<{ absolute: string; relative: string }> = [
    { absolute: workspacesDir, relative: WORKSPACES_DIR },
  ];

  while (stack.length > 0) {
    const entry = stack.pop()!;
    let children: fs.Dirent[];
    try {
      children = fs.readdirSync(entry.absolute, { withFileTypes: true });
    } catch {
      continue;
    }

    // A workspace mirror is a directory that contains at least one of the
    // known execution-state dirs as a child. Otherwise descend further.
    const hasExecChild = children.some((c) =>
      c.isDirectory() && (EXECUTION_STATE_ENTRIES as readonly string[]).includes(c.name),
    );

    if (hasExecChild) {
      results.push(entry.relative);
      continue;
    }

    for (const child of children) {
      if (!child.isDirectory()) continue;
      stack.push({
        absolute: path.join(entry.absolute, child.name),
        relative: path.join(entry.relative, child.name),
      });
    }
  }

  return results;
}

/**
 * Check whether a SQLite DB under `sessions/` has an active writer attached.
 * Presence of a non-empty `-wal` or `-shm` sidecar indicates a live connection
 * and we refuse to move the DB in that case.
 */
function isSqliteHot(dbFile: string): boolean {
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${dbFile}${suffix}`;
    try {
      const stats = fs.statSync(sidecar);
      if (stats.isFile() && stats.size > 0) return true;
    } catch {
      // Missing sidecar is fine.
    }
  }
  return false;
}

function hasHotSqliteDb(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".db")) {
      if (isSqliteHot(path.join(dir, entry.name))) return true;
    }
  }
  return false;
}

function moveEntry(source: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.renameSync(source, dest);
  } catch (err: unknown) {
    // Cross-device rename — fall back to recursive copy + delete.
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "EXDEV"
    ) {
      fs.cpSync(source, dest, { recursive: true });
      fs.rmSync(source, { recursive: true, force: true });
      return;
    }
    throw err;
  }
}

interface EntryPlan {
  /** Relative path under the supipowers root, e.g. "plans" or "workspaces/packages/api/reviews". */
  rel: string;
  /** `sessions` entries get extra hot-DB protection. */
  isSessions: boolean;
}

function collectEntryPlans(repoRoot: string): EntryPlan[] {
  const plans: EntryPlan[] = [];

  for (const name of EXECUTION_STATE_ENTRIES) {
    plans.push({ rel: name, isSessions: name === "sessions" });
  }

  for (const workspaceRel of discoverWorkspaceMirrors(repoRoot)) {
    for (const name of EXECUTION_STATE_ENTRIES) {
      plans.push({
        rel: path.join(workspaceRel, name),
        isSessions: name === "sessions",
      });
    }
  }

  return plans;
}

function processEntry(
  plan: EntryPlan,
  repoRoot: string,
  projectDir: string,
): MigrationEntryResult {
  const source = path.join(legacyRoot(repoRoot), plan.rel);
  const dest = path.join(projectDir, plan.rel);

  const sourceExists = fs.existsSync(source);
  const destExists = fs.existsSync(dest);

  if (!sourceExists) {
    return { rel: plan.rel, source, dest, status: "skipped", reason: "source-missing" };
  }

  if (destExists) {
    return {
      rel: plan.rel,
      source,
      dest,
      status: "conflict",
      reason: "destination-already-exists",
    };
  }

  if (plan.isSessions && hasHotSqliteDb(source)) {
    return {
      rel: plan.rel,
      source,
      dest,
      status: "hot-db",
      reason: "sqlite-wal-or-shm-non-empty",
    };
  }

  moveEntry(source, dest);
  return { rel: plan.rel, source, dest, status: "moved" };
}

function readMarker(markerPath: string): { migratedAt: string } | null {
  if (!fs.existsSync(markerPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(markerPath, "utf-8"));
  } catch {
    return null;
  }
}

function writeMarker(markerPath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

/**
 * Execute the execution-state migration for the repo containing `cwd`.
 * Returns a structured result describing every moved/skipped/conflicted entry.
 */
export function runMigration(options: MigrationOptions): MigrationResult {
  const identityRoot = resolveRepoIdentityRootFromFs(options.cwd);
  const slug = projectSlugFromRepoRoot(identityRoot);
  const projectDir = globalProjectDir(options.homedir, slug);
  const markerPath = path.join(legacyRoot(identityRoot), MIGRATION_MARKER_FILENAME);

  const existingMarker = readMarker(markerPath);
  if (existingMarker && !options.force) {
    return {
      repoRoot: identityRoot,
      slug,
      markerPath,
      moved: [],
      skipped: [],
      conflicts: [],
      entries: [],
      markerWritten: false,
      alreadyMigrated: true,
    };
  }

  // Ensure the destination root exists so the first renameSync has a parent.
  fs.mkdirSync(projectDir, { recursive: true });

  const plans = collectEntryPlans(identityRoot);
  const entries: MigrationEntryResult[] = plans.map((plan) =>
    processEntry(plan, identityRoot, projectDir),
  );

  const moved = entries.filter((e) => e.status === "moved");
  const skipped = entries.filter((e) => e.status === "skipped");
  const conflicts = entries.filter(
    (e) => e.status === "conflict" || e.status === "hot-db",
  );

  writeMarker(markerPath, {
    schemaVersion: MIGRATION_SCHEMA_VERSION,
    migratedAt: new Date().toISOString(),
    slug,
    identityRoot,
    projectDir,
    moved: moved.map((e) => e.rel),
    skipped: skipped.map((e) => ({ rel: e.rel, reason: e.reason })),
    conflicts: conflicts.map((e) => ({ rel: e.rel, reason: e.reason, status: e.status })),
  });

  return {
    repoRoot: identityRoot,
    slug,
    markerPath,
    moved,
    skipped,
    conflicts,
    entries,
    markerWritten: true,
    alreadyMigrated: false,
  };
}

export function formatMigrationSummary(result: MigrationResult): string[] {
  if (result.alreadyMigrated) {
    return [
      `supipowers state at ${result.repoRoot} already migrated (marker: ${result.markerPath}).`,
      "Re-run with --force to migrate again.",
    ];
  }

  const lines: string[] = [];
  lines.push(`Migrated supipowers execution state for ${result.repoRoot}`);
  lines.push(`  slug: ${result.slug}`);
  lines.push(`  moved:     ${result.moved.length}`);
  lines.push(`  skipped:   ${result.skipped.length}`);
  lines.push(`  conflicts: ${result.conflicts.length}`);
  if (result.conflicts.length > 0) {
    lines.push("");
    lines.push("Conflicts (both locations exist — inspect and resolve manually):");
    for (const c of result.conflicts) {
      lines.push(`  - ${c.rel} [${c.status}${c.reason ? ": " + c.reason : ""}]`);
      lines.push(`      source: ${c.source}`);
      lines.push(`      dest:   ${c.dest}`);
    }
  }
  lines.push("");
  lines.push(`Marker: ${result.markerPath}`);
  return lines;
}
