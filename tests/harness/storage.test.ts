import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  appendHarnessDecision,
  appendImplementLog,
  appendJsonl,
  appendScoreHistory,
  appendSlopQueueEntry,
  loadHarnessDesignSpec,
  loadHarnessDiscover,
  loadHarnessSession,
  loadHarnessValidateReport,
  readJsonl,
  readSlopQueue,
  rewriteJsonl,
  rewriteSlopQueue,
  saveHarnessDesignSpec,
  saveHarnessDiscover,
  saveHarnessRepoScore,
  saveHarnessSession,
  saveHarnessValidateReport,
  writeJsonAtomic,
  writeTextAtomic,
} from "../../src/harness/storage.js";
import {
  getHarnessDecisionsPath,
  getHarnessQueuePath,
  getHarnessRepoScorePath,
  getHarnessScoreHistoryPath,
  getHarnessSessionDir,
} from "../../src/harness/project-paths.js";
import { createTestPaths, createTestRepo } from "../ultraplan/fixtures.js";
import type {
  HarnessDiscoverArtifact,
  HarnessSession,
  HarnessSlopQueueEntry,
  HarnessValidateReport,
} from "../../src/types.js";

const SESSION_ID = "harness-test-1";

let tmpDir: string;
let cwd: string;
let paths: ReturnType<typeof createTestPaths>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-harness-storage-"));
  paths = createTestPaths(tmpDir);
  cwd = createTestRepo(tmpDir).repoRoot;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeDiscoverArtifact(overrides: Partial<HarnessDiscoverArtifact> = {}): HarnessDiscoverArtifact {
  return {
    sessionId: SESSION_ID,
    recordedAt: "2026-05-03T12:00:00.000Z",
    languages: ["typescript"],
    frameworks: [],
    packageManagers: ["bun"],
    buildTools: ["tsc"],
    testTools: ["bun:test"],
    lintTools: [],
    monorepoShape: "single-package",
    ci: { detected: false, configFiles: [] },
    ompInfra: { hasSupipowers: false, skills: [], reviewAgents: [], mcpServers: [], plansCount: 0 },
    antiSlopExisting: {
      fallowConfig: null,
      desloppifyConfig: null,
      knipConfig: null,
      jscpdConfig: null,
      dependencyCruiserConfig: null,
      eslintConfig: null,
      biomeConfig: null,
    },
    languageCoverage: [{ language: "typescript", fileCount: 100, share: 1 }],
    recommendedBackend: "fallow",
    recommendedBackendReason: "TS-only",
    commitConventions: { detected: false },
    duplicates: [],
    notes: [],
    ...overrides,
  };
}

function makeSession(overrides: Partial<HarnessSession> = {}): HarnessSession {
  return {
    sessionId: SESSION_ID,
    projectName: "supipowers",
    startedAt: "2026-05-03T12:00:00.000Z",
    updatedAt: "2026-05-03T12:00:00.000Z",
    stage: "discover",
    stageStatus: "pending",
    gateMode: "default",
    iteration: 1,
    blocker: null,
    artifacts: {},
    ...overrides,
  };
}

describe("harness/storage atomic primitives", () => {
  test("writeJsonAtomic creates the file and JSON round-trips", () => {
    const filePath = path.join(tmpDir, "out.json");
    const result = writeJsonAtomic(filePath, { a: 1, b: "two" });
    expect(result.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual({ a: 1, b: "two" });
  });

  test("writeTextAtomic appends a trailing newline if missing", () => {
    const filePath = path.join(tmpDir, "out.txt");
    writeTextAtomic(filePath, "hello");
    expect(fs.readFileSync(filePath, "utf8")).toBe("hello\n");
  });

  test("appendJsonl writes one JSON record per line", () => {
    const filePath = path.join(tmpDir, "log.jsonl");
    appendJsonl(filePath, { a: 1 });
    appendJsonl(filePath, { a: 2 });
    expect(fs.readFileSync(filePath, "utf8")).toBe('{"a":1}\n{"a":2}\n');
  });

  test("readJsonl returns parsed records and tolerates a trailing partial line", () => {
    const filePath = path.join(tmpDir, "log.jsonl");
    fs.writeFileSync(filePath, '{"a":1}\n{"a":2}\n{"a":3'); // no trailing newline → partial last line
    const result = readJsonl<{ a: number }>(filePath);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([{ a: 1 }, { a: 2 }]);
  });

  test("rewriteJsonl atomically replaces the file", () => {
    const filePath = path.join(tmpDir, "log.jsonl");
    appendJsonl(filePath, { a: 1 });
    appendJsonl(filePath, { a: 2 });
    const rewritten = rewriteJsonl(filePath, [{ a: 99 }]);
    expect(rewritten.ok).toBe(true);
    const result = readJsonl<{ a: number }>(filePath);
    if (result.ok) expect(result.value).toEqual([{ a: 99 }]);
  });
});

describe("harness/storage session lifecycle", () => {
  test("saveHarnessSession + loadHarnessSession round-trip", () => {
    const session = makeSession();
    const saved = saveHarnessSession(paths, cwd, session);
    expect(saved.ok).toBe(true);
    const loaded = loadHarnessSession(paths, cwd, SESSION_ID);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value).toEqual(session);
  });

  test("loadHarnessSession reports `missing` when no manifest exists", () => {
    const result = loadHarnessSession(paths, cwd, "nonexistent");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("missing");
  });
});

describe("harness/storage stage artifacts", () => {
  test("saveHarnessDiscover + loadHarnessDiscover", () => {
    const artifact = makeDiscoverArtifact();
    saveHarnessDiscover(paths, cwd, SESSION_ID, artifact);
    const loaded = loadHarnessDiscover(paths, cwd, SESSION_ID);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value).toEqual(artifact);
  });

  test("saveHarnessDesignSpec round-trips text", () => {
    const md = "# Design\n\nbody.";
    saveHarnessDesignSpec(paths, cwd, SESSION_ID, md);
    const loaded = loadHarnessDesignSpec(paths, cwd, SESSION_ID);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value).toContain("# Design");
  });

  test("appendHarnessDecision writes one record per call", () => {
    appendHarnessDecision(paths, cwd, SESSION_ID, { area: "x", decision: "y" });
    appendHarnessDecision(paths, cwd, SESSION_ID, { area: "z", decision: "w" });
    const decisionsPath = getHarnessDecisionsPath(paths, cwd, SESSION_ID);
    const lines = fs.readFileSync(decisionsPath, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0])).toEqual({ area: "x", decision: "y" });
  });

  test("saveHarnessValidateReport round-trips the report", () => {
    const report: HarnessValidateReport = {
      sessionId: SESSION_ID,
      recordedAt: "2026-05-03T12:00:00.000Z",
      passed: true,
      checks: [],
      slopScan: { backend: "fallow", duplicates: 0, deadCode: 0, layerViolations: 0, other: 0 },
      score: { computedAt: "2026-05-03T12:00:00.000Z", lenient: 100, strict: 100, dimensions: [] },
      scoreFloorPassed: true,
      syntheticEditTest: { ran: true, hooksFired: ["pre_edit_dupe_probe"], failures: [] },
    };
    saveHarnessValidateReport(paths, cwd, SESSION_ID, report);
    const loaded = loadHarnessValidateReport(paths, cwd, SESSION_ID);
    if (loaded.ok) expect(loaded.value).toEqual(report);
  });

  test("appendImplementLog writes JSONL", () => {
    appendImplementLog(paths, cwd, SESSION_ID, { kind: "started", at: "now" });
    const sessionDir = getHarnessSessionDir(paths, cwd, SESSION_ID);
    const log = fs.readFileSync(path.join(sessionDir, "implement-log.jsonl"), "utf8");
    expect(JSON.parse(log.trim())).toEqual({ kind: "started", at: "now" });
  });
});

describe("harness/storage queue + score persistence", () => {
  function makeEntry(overrides: Partial<HarnessSlopQueueEntry> = {}): HarnessSlopQueueEntry {
    return {
      id: "abc123",
      kind: "duplicate",
      file: "src/foo.ts",
      range: { startLine: 1, endLine: 10 },
      severity: "warning",
      source: "fallow",
      state: "open",
      message: "test",
      ts: "2026-05-03T12:00:00.000Z",
      ...overrides,
    };
  }

  test("appendSlopQueueEntry + readSlopQueue round-trips", () => {
    appendSlopQueueEntry(paths, cwd, makeEntry());
    appendSlopQueueEntry(paths, cwd, makeEntry({ id: "def456", file: "src/bar.ts" }));
    const queue = readSlopQueue(paths, cwd);
    expect(queue.ok).toBe(true);
    if (queue.ok) {
      expect(queue.value.length).toBe(2);
      expect(queue.value.map((e) => e.id).sort()).toEqual(["abc123", "def456"]);
    }
    expect(fs.existsSync(getHarnessQueuePath(paths, cwd))).toBe(true);
  });

  test("rewriteSlopQueue atomically replaces the file", () => {
    appendSlopQueueEntry(paths, cwd, makeEntry());
    rewriteSlopQueue(paths, cwd, [makeEntry({ state: "resolved" })]);
    const queue = readSlopQueue(paths, cwd);
    if (queue.ok) {
      expect(queue.value.length).toBe(1);
      expect(queue.value[0].state).toBe("resolved");
    }
  });

  test("saveHarnessRepoScore writes a score JSON", () => {
    saveHarnessRepoScore(paths, cwd, { lenient: 95, strict: 80 });
    const scorePath = getHarnessRepoScorePath(paths, cwd);
    expect(JSON.parse(fs.readFileSync(scorePath, "utf8"))).toEqual({ lenient: 95, strict: 80 });
  });

  test("appendScoreHistory writes JSONL", () => {
    appendScoreHistory(paths, cwd, { lenient: 90, strict: 75 });
    appendScoreHistory(paths, cwd, { lenient: 95, strict: 80 });
    const historyPath = getHarnessScoreHistoryPath(paths, cwd);
    const lines = fs.readFileSync(historyPath, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
  });
});
