// tests/migrate/runner.test.ts
//
// Smoke tests for the execution-state migration engine. Each test builds a
// fake repo + fake $HOME pair in a tmpdir and exercises runMigration against
// it. The production filesystem is never touched.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  EXECUTION_STATE_ENTRIES,
  MIGRATION_MARKER_FILENAME,
  MIGRATION_SCHEMA_VERSION,
  runMigration,
} from "../../src/migrate/runner.js";
import { projectSlugFromRepoRoot } from "../../src/workspace/project-slug.js";
import { resolveRepoIdentityRootFromFs } from "../../src/workspace/repo-root.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-migrate-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

interface Fixture {
  repoRoot: string;
  homedir: string;
  slug: string;
  localSupipowers: string;
  globalProjectDir: string;
  markerPath: string;
}

function makeFixture(name = "repo"): Fixture {
  const repoRoot = path.join(tmpDir, name);
  const homedir = path.join(tmpDir, "home");
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, "package.json"),
    JSON.stringify({ name }),
    "utf-8",
  );
  const identityRoot = resolveRepoIdentityRootFromFs(repoRoot);
  const slug = projectSlugFromRepoRoot(identityRoot);
  const localSupipowers = path.join(repoRoot, ".omp", "supipowers");
  const globalProjectDir = path.join(
    homedir,
    ".omp",
    "supipowers",
    "projects",
    slug,
  );
  const markerPath = path.join(localSupipowers, MIGRATION_MARKER_FILENAME);
  fs.mkdirSync(homedir, { recursive: true });
  return { repoRoot, homedir, slug, localSupipowers, globalProjectDir, markerPath };
}

function writeFile(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

describe("runMigration", () => {
  test("fresh project with no legacy state writes a marker and moves nothing", () => {
    const fx = makeFixture();

    const result = runMigration({ cwd: fx.repoRoot, homedir: fx.homedir });

    expect(result.alreadyMigrated).toBe(false);
    expect(result.markerWritten).toBe(true);
    expect(result.moved).toEqual([]);
    expect(result.conflicts).toEqual([]);
    // Every entry should be reported as skipped with reason source-missing.
    for (const entry of result.skipped) {
      expect(entry.status).toBe("skipped");
      expect(entry.reason).toBe("source-missing");
    }
    expect(fs.existsSync(fx.markerPath)).toBe(true);
    const marker = JSON.parse(fs.readFileSync(fx.markerPath, "utf-8"));
    expect(marker.schemaVersion).toBe(MIGRATION_SCHEMA_VERSION);
    expect(marker.slug).toBe(fx.slug);
  });

  test("moves legacy execution directories into the project-scoped global tree", () => {
    const fx = makeFixture();
    writeFile(path.join(fx.localSupipowers, "plans", "2026-04-23.md"), "# plan\n");
    writeFile(
      path.join(fx.localSupipowers, "reviews", "review-1", "session.json"),
      "{}",
    );
    writeFile(
      path.join(fx.localSupipowers, "reliability", "events.jsonl"),
      "{}\n",
    );
    writeFile(path.join(fx.localSupipowers, "doc-drift.json"), "{}");

    const result = runMigration({ cwd: fx.repoRoot, homedir: fx.homedir });

    expect(result.conflicts).toEqual([]);
    expect(result.moved.map((e) => e.rel).sort()).toEqual(
      ["doc-drift.json", "plans", "reliability", "reviews"].sort(),
    );

    expect(fs.existsSync(path.join(fx.localSupipowers, "plans"))).toBe(false);
    expect(fs.existsSync(path.join(fx.globalProjectDir, "plans", "2026-04-23.md"))).toBe(true);
    expect(fs.existsSync(path.join(fx.globalProjectDir, "doc-drift.json"))).toBe(true);
    expect(
      fs.existsSync(path.join(fx.globalProjectDir, "reviews", "review-1", "session.json")),
    ).toBe(true);
  });

  test("reports a conflict when both source and destination exist; nothing is moved", () => {
    const fx = makeFixture();
    writeFile(path.join(fx.localSupipowers, "plans", "legacy.md"), "# legacy\n");
    writeFile(path.join(fx.globalProjectDir, "plans", "already.md"), "# already\n");

    const result = runMigration({ cwd: fx.repoRoot, homedir: fx.homedir });

    const plansEntry = result.entries.find((e) => e.rel === "plans");
    expect(plansEntry?.status).toBe("conflict");
    // Source survives untouched.
    expect(fs.existsSync(path.join(fx.localSupipowers, "plans", "legacy.md"))).toBe(true);
    // Destination also survives.
    expect(fs.existsSync(path.join(fx.globalProjectDir, "plans", "already.md"))).toBe(true);
    expect(result.conflicts.length).toBe(1);
    // Marker still written so operators have a record of the attempt + conflicts.
    expect(fs.existsSync(fx.markerPath)).toBe(true);
    const marker = JSON.parse(fs.readFileSync(fx.markerPath, "utf-8"));
    expect(marker.conflicts[0].rel).toBe("plans");
  });

  test("re-run with an existing marker is a no-op", () => {
    const fx = makeFixture();
    writeFile(path.join(fx.localSupipowers, "plans", "first.md"), "# first\n");
    runMigration({ cwd: fx.repoRoot, homedir: fx.homedir });

    // Drop a new file back into the legacy tree; a second run without --force
    // must ignore it because the marker is present.
    writeFile(path.join(fx.localSupipowers, "reports", "r.json"), "{}");
    const second = runMigration({ cwd: fx.repoRoot, homedir: fx.homedir });

    expect(second.alreadyMigrated).toBe(true);
    expect(second.moved).toEqual([]);
    expect(second.markerWritten).toBe(false);
    expect(fs.existsSync(path.join(fx.localSupipowers, "reports", "r.json"))).toBe(true);
  });

  test("re-run with --force migrates anything new that appeared", () => {
    const fx = makeFixture();
    runMigration({ cwd: fx.repoRoot, homedir: fx.homedir });

    writeFile(path.join(fx.localSupipowers, "reports", "r.json"), "{}");
    const second = runMigration({
      cwd: fx.repoRoot,
      homedir: fx.homedir,
      force: true,
    });

    expect(second.alreadyMigrated).toBe(false);
    expect(second.moved.map((e) => e.rel)).toContain("reports");
    expect(fs.existsSync(path.join(fx.globalProjectDir, "reports", "r.json"))).toBe(true);
  });

  test("refuses to move hot SQLite databases", () => {
    const fx = makeFixture();
    const dbPath = path.join(fx.localSupipowers, "sessions", "events.db");
    writeFile(dbPath, "SQLite header stub");
    // Simulate an active writer: non-empty WAL sidecar.
    writeFile(`${dbPath}-wal`, "wal contents");

    const result = runMigration({ cwd: fx.repoRoot, homedir: fx.homedir });

    const sessionsEntry = result.entries.find((e) => e.rel === "sessions");
    expect(sessionsEntry?.status).toBe("hot-db");
    expect(result.conflicts.some((e) => e.rel === "sessions")).toBe(true);
    // Source survives untouched.
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(fs.existsSync(path.join(fx.globalProjectDir, "sessions"))).toBe(false);
  });

  test("walks workspace mirrors and migrates each workspace's execution state", () => {
    const fx = makeFixture();
    const apiPlans = path.join(
      fx.localSupipowers,
      "workspaces",
      "packages",
      "api",
      "plans",
    );
    writeFile(path.join(apiPlans, "api-plan.md"), "# api\n");
    const webReports = path.join(
      fx.localSupipowers,
      "workspaces",
      "packages",
      "web",
      "reports",
      "review-2026-04-23.json",
    );
    writeFile(webReports, "{}");

    const result = runMigration({ cwd: fx.repoRoot, homedir: fx.homedir });

    const movedRels = result.moved.map((e) => e.rel).sort();
    expect(movedRels).toContain(path.join("workspaces", "packages", "api", "plans"));
    expect(movedRels).toContain(path.join("workspaces", "packages", "web", "reports"));
    expect(
      fs.existsSync(
        path.join(
          fx.globalProjectDir,
          "workspaces",
          "packages",
          "api",
          "plans",
          "api-plan.md",
        ),
      ),
    ).toBe(true);
  });

  test("covers every canonical execution-state entry in its known list", () => {
    // Sentinel: if someone adds a new state directory to the production code
    // path but forgets to include it in EXECUTION_STATE_ENTRIES, callers lose
    // it in the migration. This test locks the invariant that the list must
    // include every execution-state segment the guardrail bans.
    expect(new Set(EXECUTION_STATE_ENTRIES)).toEqual(
      new Set([
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
      ]),
    );
  });
});
