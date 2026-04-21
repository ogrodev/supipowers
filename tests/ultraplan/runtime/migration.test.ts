import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getLegacyUltraplanSessionDir,
  getUltraplanAuthoredJsonPath,
  getUltraplanManifestPath,
  getUltraplanMigrationRecordPath,
  getUltraplanSessionDir,
} from "../../../src/ultraplan/project-paths.js";
import {
  createTestPaths,
  createTestRepo,
  makeUltraPlanAuthored,
  makeUltraPlanManifest,
  seedLegacyRepoLocalSession,
} from "../fixtures.js";
import { resolveSessionMigration } from "../../../src/ultraplan/runtime/migration.js";
import { loadUltraPlanSessionMigrationRecord } from "../../../src/ultraplan/storage.js";

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-ultraplan-migration-")); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe("resolveSessionMigration — branch 1 (no sessions)", () => {
  test("returns { kind: 'skip' } when neither global nor legacy session exists", () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    const outcome = resolveSessionMigration({
      paths,
      cwd,
      sessionId: "absent",
      nowIso: "2026-04-20T12:00:00.000Z",
    });
    expect(outcome.kind).toBe("skip");
  });
});

describe("resolveSessionMigration — branch 2 (native global, no legacy)", () => {
  test("accepts a canonical global session without writing a new migration.json", () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    const sessionId = "up-native";
    const sessionDir = getUltraplanSessionDir(paths, cwd, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      getUltraplanAuthoredJsonPath(paths, cwd, sessionId),
      `${JSON.stringify(makeUltraPlanAuthored({ sessionId }), null, 2)}\n`,
    );
    fs.writeFileSync(
      getUltraplanManifestPath(paths, cwd, sessionId),
      `${JSON.stringify(makeUltraPlanManifest({ sessionId }), null, 2)}\n`,
    );

    const outcome = resolveSessionMigration({
      paths,
      cwd,
      sessionId,
      nowIso: "2026-04-20T12:00:00.000Z",
    });
    expect(outcome.kind).toBe("native");

    // No migration.json was written for a native global session.
    expect(fs.existsSync(getUltraplanMigrationRecordPath(paths, cwd, sessionId))).toBe(false);
  });
});

describe("resolveSessionMigration — branch 6 (legacy only)", () => {
  test("copies the legacy session to the global root, writes migration.json, and renames the legacy dir", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot } = createTestRepo(tmpDir);
    const sessionId = "up-migrate-me";

    const authored = makeUltraPlanAuthored({ sessionId });
    const manifest = makeUltraPlanManifest({ sessionId });
    const legacyDir = seedLegacyRepoLocalSession(repoRoot, sessionId, {
      authored,
      manifest,
      extras: { "authored.md": "# auth\n" },
    });

    const outcome = resolveSessionMigration({
      paths,
      cwd: repoRoot,
      sessionId,
      nowIso: "2026-04-20T12:00:00.000Z",
    });

    expect(outcome.kind).toBe("migrated-copied");

    // Global session is in place with valid authored + manifest.
    expect(fs.existsSync(getUltraplanAuthoredJsonPath(paths, repoRoot, sessionId))).toBe(true);
    expect(fs.existsSync(getUltraplanManifestPath(paths, repoRoot, sessionId))).toBe(true);

    // migration.json is written with kind: copied.
    const record = loadUltraPlanSessionMigrationRecord(paths, repoRoot, sessionId);
    expect(record.ok).toBe(true);
    if (record.ok) {
      expect(record.value.kind).toBe("copied");
      expect(record.value.fingerprintBefore).toEqual(record.value.fingerprintAfter);
      expect(record.value.legacyPath).toBe(legacyDir);
      expect(record.value.legacyRenamedTo).not.toBeNull();
    }

    // Legacy dir is renamed to `.migrated-<ts>` and is no longer at its original location.
    expect(fs.existsSync(legacyDir)).toBe(false);
    const legacyParent = path.dirname(legacyDir);
    const contents = fs.readdirSync(legacyParent);
    const renamed = contents.find((name) => name.startsWith(`${sessionId}.migrated-`));
    expect(renamed).toBeDefined();
  });

  test("a second run on the same session id is a no-op: branch 2 applies with migration.json stable", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot } = createTestRepo(tmpDir);
    const sessionId = "up-migrated-once";
    const authored = makeUltraPlanAuthored({ sessionId });
    const manifest = makeUltraPlanManifest({ sessionId });
    seedLegacyRepoLocalSession(repoRoot, sessionId, { authored, manifest });

    const first = resolveSessionMigration({
      paths,
      cwd: repoRoot,
      sessionId,
      nowIso: "2026-04-20T12:00:00.000Z",
    });
    expect(first.kind).toBe("migrated-copied");

    const migrationPath = getUltraplanMigrationRecordPath(paths, repoRoot, sessionId);
    const recordBefore = fs.readFileSync(migrationPath, "utf8");

    const second = resolveSessionMigration({
      paths,
      cwd: repoRoot,
      sessionId,
      nowIso: "2026-04-20T13:00:00.000Z",
    });
    // The legacy dir has been renamed, so on the second pass there is no repo-local copy of
    // the same session id — branch 2 applies and the global session is treated as canonical.
    expect(second.kind).toBe("native");

    const recordAfter = fs.readFileSync(migrationPath, "utf8");
    expect(recordAfter).toBe(recordBefore);
  });
});


describe("resolveSessionMigration — branch 3 (same-content dual-root)", () => {
  test("writes reconciled-no-op migration.json and renames the legacy dir when contents match", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot } = createTestRepo(tmpDir);
    const sessionId = "up-reconcile";
    const authored = makeUltraPlanAuthored({ sessionId });
    const manifest = makeUltraPlanManifest({ sessionId });

    // Seed identical content under both roots.
    seedLegacyRepoLocalSession(repoRoot, sessionId, { authored, manifest });
    const globalDir = getUltraplanSessionDir(paths, repoRoot, sessionId);
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(
      getUltraplanAuthoredJsonPath(paths, repoRoot, sessionId),
      `${JSON.stringify(authored, null, 2)}\n`,
    );
    fs.writeFileSync(
      getUltraplanManifestPath(paths, repoRoot, sessionId),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    // Seed a valid migration.json so the global qualifies as canonical and branch 3 applies.
    fs.writeFileSync(
      getUltraplanMigrationRecordPath(paths, repoRoot, sessionId),
      `${JSON.stringify({
        migratedAt: "2026-04-20T10:30:00.000Z",
        legacyPath: path.join(repoRoot, ".omp", "supipowers", "ultraplans", sessionId),
        fingerprintBefore: "sha256:initial",
        fingerprintAfter: "sha256:initial",
        legacyRenamedTo: null,
        kind: "reconciled-no-op",
      }, null, 2)}\n`,
    );

    const outcome = resolveSessionMigration({
      paths,
      cwd: repoRoot,
      sessionId,
      nowIso: "2026-04-20T12:00:00.000Z",
    });
    expect(outcome.kind).toBe("reconciled-no-op");

    const record = loadUltraPlanSessionMigrationRecord(paths, repoRoot, sessionId);
    expect(record.ok).toBe(true);
    if (record.ok) {
      expect(record.value.kind).toBe("reconciled-no-op");
      expect(record.value.fingerprintBefore).toBe(record.value.fingerprintAfter);
    }

    // Legacy dir is renamed inert.
    const legacyDir = path.join(repoRoot, ".omp", "supipowers", "ultraplans", sessionId);
    expect(fs.existsSync(legacyDir)).toBe(false);
    const renamed = fs.readdirSync(path.dirname(legacyDir))
      .find((name) => name.startsWith(`${sessionId}.migrated-`));
    expect(renamed).toBeDefined();
  });
});

describe("resolveSessionMigration — branch 4 (conflicting content)", () => {
  test("emits a migration-conflict blocker and does not rename either side", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot } = createTestRepo(tmpDir);
    const sessionId = "up-conflict";
    const legacyManifest = makeUltraPlanManifest({ sessionId, updatedAt: "2026-04-20T10:00:00.000Z" });
    const globalManifest = makeUltraPlanManifest({ sessionId, updatedAt: "2026-04-20T11:00:00.000Z" });
    seedLegacyRepoLocalSession(repoRoot, sessionId, {
      authored: makeUltraPlanAuthored({ sessionId }),
      manifest: legacyManifest,
    });
    const globalDir = getUltraplanSessionDir(paths, repoRoot, sessionId);
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(
      getUltraplanAuthoredJsonPath(paths, repoRoot, sessionId),
      `${JSON.stringify(makeUltraPlanAuthored({ sessionId }), null, 2)}\n`,
    );
    fs.writeFileSync(
      getUltraplanManifestPath(paths, repoRoot, sessionId),
      `${JSON.stringify(globalManifest, null, 2)}\n`,
    );
    // Seed a valid migration.json so the global qualifies as canonical per the delta spec.
    fs.writeFileSync(
      getUltraplanMigrationRecordPath(paths, repoRoot, sessionId),
      `${JSON.stringify({
        migratedAt: "2026-04-20T10:30:00.000Z",
        legacyPath: path.join(repoRoot, ".omp", "supipowers", "ultraplans", sessionId),
        fingerprintBefore: "sha256:stale",
        fingerprintAfter: "sha256:stale",
        legacyRenamedTo: null,
        kind: "copied",
      }, null, 2)}\n`,
    );

    const outcome = resolveSessionMigration({
      paths,
      cwd: repoRoot,
      sessionId,
      nowIso: "2026-04-20T12:00:00.000Z",
    });
    expect(outcome.kind).toBe("blocked");
    if (outcome.kind === "blocked") {
      expect(outcome.blocker.code).toBe("migration-conflict");
    }
    // Neither side is mutated.
    const legacyDir = path.join(repoRoot, ".omp", "supipowers", "ultraplans", sessionId);
    expect(fs.existsSync(legacyDir)).toBe(true);
    expect(fs.existsSync(globalDir)).toBe(true);
  });
});

describe("resolveSessionMigration — branch 5 (partial global, valid legacy)", () => {
  test("renames the partial global dir to .interrupted-<ts> and migrates from legacy via branch 6", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot } = createTestRepo(tmpDir);
    const sessionId = "up-partial-global";

    // Legacy is valid.
    seedLegacyRepoLocalSession(repoRoot, sessionId, {
      authored: makeUltraPlanAuthored({ sessionId }),
      manifest: makeUltraPlanManifest({ sessionId }),
    });

    // Global directory exists but authored.json is missing (partial/interrupted).
    const globalDir = getUltraplanSessionDir(paths, repoRoot, sessionId);
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(
      getUltraplanManifestPath(paths, repoRoot, sessionId),
      `${JSON.stringify(makeUltraPlanManifest({ sessionId }), null, 2)}\n`,
    );

    const outcome = resolveSessionMigration({
      paths,
      cwd: repoRoot,
      sessionId,
      nowIso: "2026-04-20T12:00:00.000Z",
    });
    expect(outcome.kind).toBe("migrated-copied");

    // The partial global is renamed to `.interrupted-<ts>` and now the canonical global session lives at its original path.
    const globalParent = path.dirname(globalDir);
    const contents = fs.readdirSync(globalParent);
    const interruptedName = contents.find((name) => name.startsWith(`${sessionId}.interrupted-`));
    expect(interruptedName).toBeDefined();
    expect(fs.existsSync(getUltraplanAuthoredJsonPath(paths, repoRoot, sessionId))).toBe(true);
    expect(fs.existsSync(getUltraplanManifestPath(paths, repoRoot, sessionId))).toBe(true);
  });

  test("mid-copy crash (global has authored+manifest but no migration.json) resolves via branch 5 on retry", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot } = createTestRepo(tmpDir);
    const sessionId = "up-mid-copy";
    const authored = makeUltraPlanAuthored({ sessionId });
    const manifest = makeUltraPlanManifest({ sessionId });

    // Legacy still present.
    seedLegacyRepoLocalSession(repoRoot, sessionId, { authored, manifest });

    // Simulate a mid-copy crash: global has the content but no migration.json.
    const globalDir = getUltraplanSessionDir(paths, repoRoot, sessionId);
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(
      getUltraplanAuthoredJsonPath(paths, repoRoot, sessionId),
      `${JSON.stringify(authored, null, 2)}\n`,
    );
    fs.writeFileSync(
      getUltraplanManifestPath(paths, repoRoot, sessionId),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    // NOTE: no migration.json written; since legacy exists, this directory is not canonical.

    const outcome = resolveSessionMigration({
      paths,
      cwd: repoRoot,
      sessionId,
      nowIso: "2026-04-20T12:00:00.000Z",
    });
    // On retry, branch 5 applies: partial/non-canonical global is renamed to .interrupted-<ts>
    // and the legacy is migrated in (branch 6 under the covers).
    expect(outcome.kind).toBe("migrated-copied");
    const globalParent = path.dirname(globalDir);
    const contents = fs.readdirSync(globalParent);
    expect(contents.find((name) => name.startsWith(`${sessionId}.interrupted-`))).toBeDefined();
  });
});

describe("resolveSessionMigration — branch 7 (non-canonical global, no legacy)", () => {
  test("renames the global dir and emits a migration-unsafe blocker naming the interrupted path", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot } = createTestRepo(tmpDir);
    const sessionId = "up-orphan-global";

    // Global exists but has only authored.json (manifest missing) — not canonical.
    const globalDir = getUltraplanSessionDir(paths, repoRoot, sessionId);
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(
      getUltraplanAuthoredJsonPath(paths, repoRoot, sessionId),
      `${JSON.stringify(makeUltraPlanAuthored({ sessionId }), null, 2)}\n`,
    );

    const outcome = resolveSessionMigration({
      paths,
      cwd: repoRoot,
      sessionId,
      nowIso: "2026-04-20T12:00:00.000Z",
    });
    expect(outcome.kind).toBe("blocked");
    if (outcome.kind === "blocked") {
      expect(outcome.blocker.code).toBe("migration-unsafe");
      expect(String(outcome.blocker.details?.interruptedPath ?? "")).toMatch(new RegExp(`${sessionId}\\.interrupted-`));
    }
    // Rename happened.
    expect(fs.existsSync(globalDir)).toBe(false);
  });
});