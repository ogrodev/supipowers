import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  UltraPlanAuthoredArtifact,
  UltraPlanManifest,
} from "../../src/types.js";
import {
  getUltraplanAuthoredJsonPath,
  getUltraplanIndexPath,
  getUltraplanManifestPath,
  getUltraplanSessionDir,
} from "../../src/ultraplan/project-paths.js";
import {
  persistAuthoredUltraPlanSession,
  type AuthoringPersistInput,
} from "../../src/ultraplan/authoring-persist.js";
import {
  createTestPaths,
  createTestRepo,
  makeUltraPlanAuthored,
  makeUltraPlanManifest,
  makeCatalogFixture,
} from "./fixtures.js";



let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-ultraplan-authoring-persist-"));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeInput(overrides: {
  sessionId?: string;
  authoredOverrides?: Partial<UltraPlanAuthoredArtifact>;
  manifestOverrides?: Partial<UltraPlanManifest>;
} = {}): AuthoringPersistInput {
  const sessionId = overrides.sessionId ?? "up-test";
  const paths = createTestPaths(tmpDir);
  const cwd = createTestRepo(tmpDir).repoRoot;
  const authored = makeUltraPlanAuthored({ sessionId, ...overrides.authoredOverrides });
  const manifest = makeUltraPlanManifest({ sessionId, ...overrides.manifestOverrides });
  return { paths, cwd, authored, manifest };
}

describe("authoring-persist module exports", () => {
  test("persistAuthoredUltraPlanSession is defined", () => {
    expect(typeof persistAuthoredUltraPlanSession).toBe("function");
  });
});

describe("persistAuthoredUltraPlanSession — index load-and-validate", () => {
  test("missing index is treated as empty-index bootstrap (first-session)", () => {
    const input = makeInput();
    const result = persistAuthoredUltraPlanSession(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(fs.existsSync(getUltraplanIndexPath(input.paths, input.cwd))).toBe(true);
    }
  });

  test("malformed JSON in index.json aborts with index-invalid (invalid-json)", () => {
    const input = makeInput();
    const indexPath = getUltraplanIndexPath(input.paths, input.cwd);
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(indexPath, "{not valid");

    const result = persistAuthoredUltraPlanSession(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("index-invalid");
      if (result.error.kind === "index-invalid") {
        expect(result.error.error.kind).toBe("invalid-json");
      }
    }

    // No session dir on disk
    expect(fs.existsSync(getUltraplanSessionDir(input.paths, input.cwd, input.authored.sessionId))).toBe(false);
  });

  test("schema-invalid JSON in index.json aborts with index-invalid (validation-error)", () => {
    const input = makeInput();
    const indexPath = getUltraplanIndexPath(input.paths, input.cwd);
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(indexPath, JSON.stringify({ sessions: "not-array" }));

    const result = persistAuthoredUltraPlanSession(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("index-invalid");
      if (result.error.kind === "index-invalid") {
        expect(result.error.error.kind).toBe("validation-error");
      }
    }

    // No session dir on disk
    expect(fs.existsSync(getUltraplanSessionDir(input.paths, input.cwd, input.authored.sessionId))).toBe(false);
  });
});

// Unused imports silencer (used in later tasks)
void getUltraplanAuthoredJsonPath;
void getUltraplanManifestPath;


function seedIndex(paths: ReturnType<typeof createTestPaths>, cwd: string, entries: UltraPlanAuthoredArtifact[]): void {
  const indexPath = getUltraplanIndexPath(paths, cwd);
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  const index = {
    sessions: entries.map((a) => ({
      sessionId: a.sessionId,
      title: a.title,
      state: "ready" as const,
      bucket: "pending" as const,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
      cursor: null,
      idleReason: null,
    })),
  };
  fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
}

function seedManifest(paths: ReturnType<typeof createTestPaths>, cwd: string, manifest: UltraPlanManifest): void {
  const manifestPath = getUltraplanManifestPath(paths, cwd, manifest.sessionId);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

describe("persistAuthoredUltraPlanSession — debris / collision", () => {
  test("pre-seeded index entry + valid manifest → session-id-exists", () => {
    const input = makeInput();
    // Seed an index entry AND a valid manifest
    seedIndex(input.paths, input.cwd, [input.authored]);
    seedManifest(input.paths, input.cwd, input.manifest);

    const before = fs.readFileSync(getUltraplanManifestPath(input.paths, input.cwd, input.authored.sessionId));
    const result = persistAuthoredUltraPlanSession(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("session-id-exists");
    const after = fs.readFileSync(getUltraplanManifestPath(input.paths, input.cwd, input.authored.sessionId));
    expect(after.equals(before)).toBe(true);
  });

  test("stale debris — index entry but no manifest → reclaim and succeed", () => {
    const input = makeInput();
    seedIndex(input.paths, input.cwd, [input.authored]);
    // Drop a stray file in the session dir to mimic aborted persist
    const sessionDir = getUltraplanSessionDir(input.paths, input.cwd, input.authored.sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "authored.json"), "{partial");

    const result = persistAuthoredUltraPlanSession(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reclaimed).toBe(true);
      expect(fs.existsSync(getUltraplanManifestPath(input.paths, input.cwd, input.authored.sessionId))).toBe(true);
    }
  });

  test("stale debris with corrupt manifest → reclaim and succeed", () => {
    const input = makeInput();
    seedIndex(input.paths, input.cwd, [input.authored]);
    const sessionDir = getUltraplanSessionDir(input.paths, input.cwd, input.authored.sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(getUltraplanManifestPath(input.paths, input.cwd, input.authored.sessionId), "{not-json");

    const result = persistAuthoredUltraPlanSession(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.reclaimed).toBe(true);
  });

  test("no prior entry → reclaimed: false", () => {
    const input = makeInput();
    const result = persistAuthoredUltraPlanSession(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.reclaimed).toBe(false);
  });
});

describe("persistAuthoredUltraPlanSession — atomic write happy path", () => {
  test("writes authored.json, manifest.json, index.json with correct paths and reclaimed=false", () => {
    const input = makeInput();
    const result = persistAuthoredUltraPlanSession(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const expectedAuthored = getUltraplanAuthoredJsonPath(input.paths, input.cwd, input.authored.sessionId);
    const expectedManifest = getUltraplanManifestPath(input.paths, input.cwd, input.authored.sessionId);
    const expectedIndex = getUltraplanIndexPath(input.paths, input.cwd);
    expect(result.authoredPath).toBe(expectedAuthored);
    expect(result.manifestPath).toBe(expectedManifest);
    expect(result.indexPath).toBe(expectedIndex);
    expect(result.reclaimed).toBe(false);

    // Round-trip byte-identical
    const authoredJson = JSON.parse(fs.readFileSync(expectedAuthored, "utf8"));
    expect(authoredJson).toEqual(input.authored);
    const manifestJson = JSON.parse(fs.readFileSync(expectedManifest, "utf8"));
    expect(manifestJson).toEqual(input.manifest);
  });

  test("index.json includes the new session entry and preserves prior siblings", () => {
    const input = makeInput();
    // Seed index with an unrelated prior session that has no on-disk manifest (just an entry)
    const prior = makeUltraPlanAuthored({ sessionId: "up-prior", title: "Prior" });
    // Use a separate path so collision logic doesn't see prior as debris for our new entry
    const priorIndex = {
      sessions: [{
        sessionId: prior.sessionId,
        title: prior.title,
        state: "ready" as const,
        bucket: "pending" as const,
        createdAt: prior.createdAt,
        updatedAt: prior.updatedAt,
        cursor: null,
        idleReason: null,
      }],
    };
    const indexPath = getUltraplanIndexPath(input.paths, input.cwd);
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(indexPath, `${JSON.stringify(priorIndex, null, 2)}\n`);

    const result = persistAuthoredUltraPlanSession(input);
    expect(result.ok).toBe(true);

    const loadedIndex = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    expect(loadedIndex.sessions).toHaveLength(2);
    expect(loadedIndex.sessions.map((s: { sessionId: string }) => s.sessionId).sort()).toEqual(["up-prior", "up-test"]);
  });

  test("replaces an existing entry of the same id (after reclaim)", () => {
    const input = makeInput();
    // Seed index with an entry bearing the same id we are now persisting, but without a valid manifest.
    seedIndex(input.paths, input.cwd, [input.authored]);
    const sessionDir = getUltraplanSessionDir(input.paths, input.cwd, input.authored.sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "authored.json"), "{partial");

    const result = persistAuthoredUltraPlanSession(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reclaimed).toBe(true);

    const indexPath = getUltraplanIndexPath(input.paths, input.cwd);
    const loadedIndex = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    const entries = loadedIndex.sessions.filter((s: { sessionId: string }) => s.sessionId === input.authored.sessionId);
    expect(entries).toHaveLength(1);
  });
});

describe("persistAuthoredUltraPlanSession — rollback on each step", () => {
  test("authored-write failure returns storage-error with written: [] and no index mutation", () => {
    const input = makeInput();
    // Pre-seed a valid index so we can detect if it mutates on failure
    const indexPath = getUltraplanIndexPath(input.paths, input.cwd);
    const priorIndex = { sessions: [] };
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(indexPath, `${JSON.stringify(priorIndex, null, 2)}\n`);
    const indexBefore = fs.readFileSync(indexPath);

    // Bypass TypeBox via cast: empty title fails validateUltraPlanAuthoredArtifact.
    const bad = { ...input.authored, title: "" } as unknown as typeof input.authored;
    const result = persistAuthoredUltraPlanSession({ ...input, authored: bad });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("storage-error");
      if (result.error.kind === "storage-error") {
        expect(result.error.written).toEqual([]);
        expect(result.error.error.kind).toBe("validation-error");
      }
    }
    const indexAfter = fs.readFileSync(indexPath);
    expect(indexAfter.equals(indexBefore)).toBe(true);
  });

  test("manifest-write failure unlinks authored.json; written: [authoredPath]", () => {
    const input = makeInput();
    const indexPath = getUltraplanIndexPath(input.paths, input.cwd);
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(indexPath, `${JSON.stringify({ sessions: [] }, null, 2)}\n`);
    const indexBefore = fs.readFileSync(indexPath);

    const badManifest = { ...input.manifest, title: "" } as unknown as typeof input.manifest;
    const result = persistAuthoredUltraPlanSession({ ...input, manifest: badManifest });
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "storage-error") {
      const authoredPath = getUltraplanAuthoredJsonPath(input.paths, input.cwd, input.authored.sessionId);
      expect(result.error.written).toEqual([authoredPath]);
      expect(fs.existsSync(authoredPath)).toBe(false);
    }
    // Index unchanged
    expect(fs.readFileSync(indexPath).equals(indexBefore)).toBe(true);
  });

  const skipOnWindows = process.platform === "win32";
  test.skipIf(skipOnWindows)("index-write failure unlinks manifest and authored; written: [authoredPath, manifestPath]", () => {
    const input = makeInput();
    // Seed a read-only index.json
    const indexPath = getUltraplanIndexPath(input.paths, input.cwd);
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(indexPath, `${JSON.stringify({ sessions: [] }, null, 2)}\n`);
    const indexBefore = fs.readFileSync(indexPath);
    fs.chmodSync(indexPath, 0o444);
    try {
      const result = persistAuthoredUltraPlanSession(input);
      expect(result.ok).toBe(false);
      if (!result.ok && result.error.kind === "storage-error") {
        const authoredPath = getUltraplanAuthoredJsonPath(input.paths, input.cwd, input.authored.sessionId);
        const manifestPath = getUltraplanManifestPath(input.paths, input.cwd, input.authored.sessionId);
        expect(result.error.written).toEqual([authoredPath, manifestPath]);
        expect(fs.existsSync(authoredPath)).toBe(false);
        expect(fs.existsSync(manifestPath)).toBe(false);
      }
      // Index on disk unchanged (still the seeded empty one)
      expect(fs.readFileSync(indexPath).equals(indexBefore)).toBe(true);
    } finally {
      // Restore permissions so tmpDir cleanup can unlink
      fs.chmodSync(indexPath, 0o644);
    }
  });
});

describe("persistAuthoredUltraPlanSession — integration with picker surface", () => {
  test("persist → loadUltraPlanIndex / loadUltraPlanSessionSummary / getVisibleUltraPlanSessions / resolveUltraPlanCurrentCursor round-trip", async () => {
    const { addDomain, addScenario, buildInitialAuthoredDraft, draftToAuthoredArtifact, draftToManifest } = await import("../../src/ultraplan/authoring-draft.js");
    const { loadUltraPlanIndex, loadUltraPlanSessionSummary } = await import("../../src/ultraplan/storage.js");
    const { getVisibleUltraPlanSessions, resolveUltraPlanCurrentCursor } = await import("../../src/ultraplan/session-selection.js");

    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    const createdAt = new Date("2026-04-21T10:00:00.000Z");
    const now = new Date("2026-04-21T11:00:00.000Z");
    let draft = buildInitialAuthoredDraft({
      sessionId: "up-integration",
      title: "Integration test",
      goal: "Round-trip",
      createdAt,
      catalog: makeCatalogFixture(),
    });
    const d1 = addDomain(draft, "frontend", { id: "auth", name: "Auth" });
    if (!d1.ok) throw new Error("addDomain failed");
    const d2 = addScenario(d1.draft, { stack: "frontend", domainId: "auth", level: "unit" }, { id: "login", title: "Login renders" });
    if (!d2.ok) throw new Error("addScenario failed");
    draft = d2.draft;

    const authored = draftToAuthoredArtifact(draft, now);
    const manifest = draftToManifest(draft, "supipowers", now);

    const result = persistAuthoredUltraPlanSession({ paths, cwd, authored, manifest });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const loadedIndex = loadUltraPlanIndex(paths, cwd);
    expect(loadedIndex.ok).toBe(true);
    if (!loadedIndex.ok) return;
    expect(loadedIndex.value.sessions.map((s) => s.sessionId)).toContain("up-integration");

    const summary = loadUltraPlanSessionSummary(paths, cwd, "up-integration");
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    expect(summary.value.state).toBe("ready");

    const visible = getVisibleUltraPlanSessions([summary.value]);
    expect(visible).toHaveLength(1);
    expect(visible[0].bucket).toBe("pending");

    const resolved = resolveUltraPlanCurrentCursor(manifest, authored);
    expect(resolved.cursor.targetType).toBe("scenario");
    expect(resolved.cursor.phase).toBe("red");
    expect(resolved.cursor.status).toBe("planned");
  });
});