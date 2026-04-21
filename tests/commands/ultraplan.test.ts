import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { UltraPlanIndex } from "../../src/types.js";
import {
  getUltraplanAuthoredJsonPath,
  getUltraplanIndexPath,
  getUltraplanManifestPath,
  getUltraplanMigrationRecordPath,
  getUltraplanSessionDir,
} from "../../src/ultraplan/project-paths.js";
import { loadVisibleSessionsForTesting } from "../../src/commands/ultraplan.js";
import {
  createTestPaths,
  createTestRepo,
  makeUltraPlanAuthored,
  makeUltraPlanManifest,
  seedLegacyRepoLocalSession,
} from "../ultraplan/fixtures.js";

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-ultraplan-cmd-")); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function seedGlobalIndex(paths: ReturnType<typeof createTestPaths>, cwd: string, index: UltraPlanIndex): void {
  const indexPath = getUltraplanIndexPath(paths, cwd);
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
}

function seedCanonicalGlobalSession(
  paths: ReturnType<typeof createTestPaths>,
  cwd: string,
  sessionId: string,
): void {
  const dir = getUltraplanSessionDir(paths, cwd, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    getUltraplanAuthoredJsonPath(paths, cwd, sessionId),
    `${JSON.stringify(makeUltraPlanAuthored({ sessionId }), null, 2)}\n`,
  );
  fs.writeFileSync(
    getUltraplanManifestPath(paths, cwd, sessionId),
    `${JSON.stringify(makeUltraPlanManifest({ sessionId }), null, 2)}\n`,
  );
}

describe("loadVisibleSessions — migration integration", () => {
  test("native global session loads successfully and reports no migration failures", () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    seedCanonicalGlobalSession(paths, cwd, "up-native");
    seedGlobalIndex(paths, cwd, {
      sessions: [{
        sessionId: "up-native",
        title: "Auth slice",
        state: "ready",
        bucket: "pending",
        createdAt: "2026-04-19T12:00:00.000Z",
        updatedAt: "2026-04-19T12:00:00.000Z",
        cursor: null,
        idleReason: null,
      }],
    });

    const result = loadVisibleSessionsForTesting({ platform: { paths } as any, cwd });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.sessions.length).toBe(1);
      expect(result.failures.length).toBe(0);
    }
  });

  test("migration-unsafe outcome folds into failures via formatVisibleSessionFailure", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const sessionId = "up-broken";

    // Seed a partial global directory (authored only — manifest missing) and no legacy copy.
    // The migration engine classifies this as branch 7 and emits a migration-unsafe blocker.
    const sessionDir = getUltraplanSessionDir(paths, cwd, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      getUltraplanAuthoredJsonPath(paths, cwd, sessionId),
      `${JSON.stringify(makeUltraPlanAuthored({ sessionId }), null, 2)}\n`,
    );
    seedGlobalIndex(paths, cwd, {
      sessions: [{
        sessionId,
        title: "Broken session",
        state: "ready",
        bucket: "pending",
        createdAt: "2026-04-19T12:00:00.000Z",
        updatedAt: "2026-04-19T12:00:00.000Z",
        cursor: null,
        idleReason: null,
      }],
    });

    const result = loadVisibleSessionsForTesting({ platform: { paths } as any, cwd });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.failures.length).toBe(1);
      expect(result.failures[0].sessionId).toBe(sessionId);
      expect(result.failures[0].message).toContain(sessionId);
      expect(result.failures[0].message.toLowerCase()).toContain("migration-unsafe");
    }
  });

  test("legacy-only session migrates automatically and appears as an ok session", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const sessionId = "up-legacy";
    seedLegacyRepoLocalSession(cwd, sessionId, {
      authored: makeUltraPlanAuthored({ sessionId }),
      manifest: makeUltraPlanManifest({ sessionId }),
    });
    seedGlobalIndex(paths, cwd, {
      sessions: [{
        sessionId,
        title: "Legacy session",
        state: "ready",
        bucket: "pending",
        createdAt: "2026-04-19T12:00:00.000Z",
        updatedAt: "2026-04-19T12:00:00.000Z",
        cursor: null,
        idleReason: null,
      }],
    });

    const result = loadVisibleSessionsForTesting({ platform: { paths } as any, cwd });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.sessions.length).toBe(1);
      expect(result.failures.length).toBe(0);
    }
    // migration.json was written.
    expect(fs.existsSync(getUltraplanMigrationRecordPath(paths, cwd, sessionId))).toBe(true);
  });
});
