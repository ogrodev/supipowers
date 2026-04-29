import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createPaths, type Platform } from "../../src/platform/types.js";
import { checkCapabilities, checkConfig, checkLazyTools, formatReliabilityReportLines } from "../../src/commands/doctor.js";
import { appendReliabilityRecord } from "../../src/storage/reliability-metrics.js";

function createTestPaths(rootDir: string): ReturnType<typeof createPaths> {
  return {
    dotDir: ".omp",
    dotDirDisplay: ".omp",
    project: (cwd: string, ...segments: string[]) =>
      path.join(cwd, ".omp", "supipowers", ...segments),
    global: (...segments: string[]) =>
      path.join(rootDir, "global-config", ".omp", "supipowers", ...segments),
    agent: (...segments: string[]) => path.join(rootDir, "agent", ...segments),
  };
}

function createPlatform(localPaths: ReturnType<typeof createPaths>): Platform {
  return {
    name: "omp",
    registerCommand: mock(),
    getCommands: mock(() => []),
    on: mock(),
    exec: mock(),
    sendMessage: mock(),
    sendUserMessage: mock(),
    getActiveTools: mock(() => []),
    registerMessageRenderer: mock(),
    createAgentSession: mock(),
    paths: localPaths,
    capabilities: {
      agentSessions: true,
      compactionHooks: false,
      customWidgets: false,
      registerTool: false,
      activeToolFiltering: false,
    },
  } as unknown as Platform;
}

describe("checkConfig", () => {
  let tmpDir: string;
  let localPaths: ReturnType<typeof createPaths>;
  let platform: Platform;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-doctor-test-"));
    localPaths = createTestPaths(tmpDir);
    platform = createPlatform(localPaths);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("reports quality gate config errors instead of defaultProfile", async () => {
    const configPath = localPaths.project(tmpDir, "config.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "{ invalid json");

    const result = await checkConfig(platform, tmpDir);

    expect(result.functional?.detail).toMatch(/JSON Parse error|Unexpected token/);
  });
});

describe("active-tool filtering doctor checks", () => {
  let tmpDir: string;
  let localPaths: ReturnType<typeof createPaths>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-doctor-lazy-tools-"));
    localPaths = createTestPaths(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("checkCapabilities reports active-tool filtering capability", () => {
    const healthy = checkCapabilities(
      { agentSessions: true, compactionHooks: true, customWidgets: true, registerTool: true, activeToolFiltering: true },
      false,
    );
    const degraded = checkCapabilities(
      { agentSessions: true, compactionHooks: true, customWidgets: true, registerTool: true, activeToolFiltering: false },
      false,
    );

    expect(healthy.find((check) => check.name === "activeToolFiltering")?.presence.ok).toBe(true);
    expect(degraded.find((check) => check.name === "activeToolFiltering")?.presence.ok).toBe(false);
  });

  test("checkLazyTools reports healthy when L7 is enabled and platform capability exists", () => {
    const platform = createPlatform(localPaths);
    platform.capabilities.activeToolFiltering = true;

    const result = checkLazyTools(platform, tmpDir);

    expect(result.name).toBe("Lazy Tools");
    expect(result.presence.ok).toBe(true);
    expect(result.presence.detail).toContain("active-tool filtering available");
  });

  test("checkLazyTools reports degraded when L7 is enabled but platform capability is missing", () => {
    const platform = createPlatform(localPaths);
    platform.capabilities.activeToolFiltering = false;

    const result = checkLazyTools(platform, tmpDir);

    expect(result.presence.ok).toBe(false);
    expect(result.presence.detail).toContain("contextMode.lazyTools.enabled");
    expect(result.presence.detail).toContain("upgrade OMP");
  });

  test("checkLazyTools reports invalid config instead of defaulting to healthy", () => {
    const platform = createPlatform(localPaths);
    platform.capabilities.activeToolFiltering = true;
    const configPath = localPaths.project(tmpDir, "config.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({ contextMode: { lazyTools: { enabled: true, mode: "reckless" } } }),
    );

    const result = checkLazyTools(platform, tmpDir);

    expect(result.presence.ok).toBe(false);
    expect(result.presence.detail).toContain("config is invalid");
    expect(result.functional?.ok).toBe(false);
    expect(result.functional?.detail).toContain("contextMode.lazyTools.mode");
  });
});

describe("formatReliabilityReportLines", () => {
  let tmpDir: string;
  let platform: Platform;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-doctor-reliability-"));
    platform = createPlatform(createTestPaths(tmpDir));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("renders empty-state line when no records exist", () => {
    const lines = formatReliabilityReportLines(platform, tmpDir);
    expect(lines).toEqual([
      "Reliability: no records yet (metrics appear after AI-heavy commands run).",
    ]);
  });

  test("renders per-command rows aggregated from stored records", () => {
    appendReliabilityRecord(platform.paths, tmpDir, {
      ts: "2026-04-14T10:00:00.000Z",
      command: "review",
      outcome: "ok",
      attempts: 1,
    });
    appendReliabilityRecord(platform.paths, tmpDir, {
      ts: "2026-04-15T10:00:00.000Z",
      command: "review",
      outcome: "retry-exhausted",
      attempts: 3,
    });

    const lines = formatReliabilityReportLines(platform, tmpDir);
    expect(lines[0]).toBe("Reliability (last 2 records)");
    const row = lines.find((l) => l.startsWith("review"));
    expect(row).toBeDefined();
    expect(row).toContain("ok 1");
    expect(row).toContain("retry-exhausted 1");
    expect(row).toContain("avg-attempts 2.0");
    expect(row).toContain("last 2026-04-15");
  });
});

// \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// L1 metrics doctor checks (Tasks 48\u201351)
// \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

import { checkMetrics } from "../../src/commands/doctor.js";
import {
  MetricsStore,
  __setMetricsStoreForTest,
  _resetMetricsStoreCache,
} from "../../src/context-mode/metrics-store.js";
import { _resetCache as _resetHooksCache } from "../../src/context-mode/hooks.js";
import { rmDirWithRetry } from "../helpers/fs.js";

describe("checkMetrics \u2014 L1 doctor section", () => {
  let tmpDir: string;
  let dbPath: string;
  let store: MetricsStore;
  let platform: Platform;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-doctor-metrics-"));
    dbPath = path.join(tmpDir, "metrics.db");
    const localPaths = {
      dotDir: ".omp",
      dotDirDisplay: ".omp",
      project: (_cwd: string, ...segments: string[]) =>
        path.join(tmpDir, "project", ...segments),
      global: (...segments: string[]) =>
        path.join(tmpDir, "global", ...segments),
      agent: (...segments: string[]) => path.join(tmpDir, "agent", ...segments),
    };
    platform = createPlatform(localPaths);
    store = new MetricsStore({ dbPath, projectSlug: "demo" });
    store.init();
    __setMetricsStoreForTest(store);
  });

  afterEach(() => {
    try { store.close(); } catch { /* already closed */ }
    _resetMetricsStoreCache();
    _resetHooksCache();
    rmDirWithRetry(tmpDir);
  });

  test("metrics-db-reachable passes when the store is open and section title shows the absolute DB path (Tasks 48 + 51)", () => {
    const { section, absDbPath } = checkMetrics(platform, tmpDir);
    expect(absDbPath).toContain("metrics.db");
    expect(section.title).toContain(absDbPath);
    const reachable = section.checks.find((c) => c.name === "metrics-db-reachable");
    expect(reachable).toBeDefined();
    expect(reachable!.presence.ok).toBe(true);
  });

  test("metrics-write-healthy fails when write_failures > 0 (Task 49)", () => {
    // Synthetic failure: close the store mid-flight then issue a record so the
    // in-memory failure counter is bumped.
    store.close();
    store.record({
      session_id: "",
      ts: Date.now(),
      layer: "L2",
      tool: "bash",
      processor: "bash",
      before_bytes: 1000,
      after_bytes: 100,
      cache_hit: 0,
      unique_source_hash: null,
      context_tokens: null,
      context_window: null,
      context_percent: null,
    });
    const { section } = checkMetrics(platform, tmpDir);
    const writeHealthy = section.checks.find((c) => c.name === "metrics-write-healthy");
    expect(writeHealthy).toBeDefined();
    expect(writeHealthy!.presence.ok).toBe(false);
    expect(writeHealthy!.presence.detail).toContain("write_failures");
  });

  test("metrics-prune-fresh fails after 24h staleness (Task 50)", () => {
    const now = 1_700_000_000_000;
    // Set last_prune_at = 25h ago via setFirstRunNoticeShown's neighbor:
    // we directly upsert via runtime SQL for precision.
    store["#db" as never]; // touch private to validate access at compile time
    const oldPrune = now - 25 * 60 * 60 * 1000;
    // Use the public path: pruneOldSessions writes last_prune_at, so simulate
    // a stale prune by calling it with the frozen `now` argument.
    store.pruneOldSessions(7, oldPrune);
    const { section } = checkMetrics(platform, tmpDir, now);
    const prune = section.checks.find((c) => c.name === "metrics-prune-fresh");
    expect(prune).toBeDefined();
    expect(prune!.presence.ok).toBe(false);
    expect(prune!.presence.detail).toContain("Stale");
  });

  test("metrics-prune-fresh passes when last prune is within 24h (Task 50 happy path)", () => {
    const now = 1_700_000_000_000;
    store.pruneOldSessions(7, now - 60 * 60 * 1000); // 1h ago
    const { section } = checkMetrics(platform, tmpDir, now);
    const prune = section.checks.find((c) => c.name === "metrics-prune-fresh");
    expect(prune!.presence.ok).toBe(true);
  });

  test("metrics-db-reachable reports init failure when store is null and config defaults to enabled", () => {
    // Tear down the live store the suite installed and clear the ref.
    store.close();
    __setMetricsStoreForTest(null);
    _resetMetricsStoreCache();

    const { section } = checkMetrics(platform, tmpDir);
    const reachable = section.checks.find((c) => c.name === "metrics-db-reachable");
    expect(reachable).toBeDefined();
    expect(reachable!.presence.ok).toBe(false);
    expect(reachable!.presence.detail).toContain("Failed to initialize");
    expect(reachable!.presence.detail).not.toContain("/supi:context");
  });

  test("metrics-db-reachable reports disabled when contextMode.enabled = false", () => {
    store.close();
    __setMetricsStoreForTest(null);
    _resetMetricsStoreCache();

    // Write a project config that disables context-mode so inspectConfig surfaces it.
    // localPaths.project resolves to <tmpDir>/project/<segments>; getRootConfigPath
    // calls paths.project(repoRoot, "config.json").
    const projectConfigPath = path.join(tmpDir, "project", "config.json");
    fs.mkdirSync(path.dirname(projectConfigPath), { recursive: true });
    fs.writeFileSync(
      projectConfigPath,
      JSON.stringify({ contextMode: { enabled: false } }, null, 2) + "\n",
    );

    const { section } = checkMetrics(platform, tmpDir);
    const reachable = section.checks.find((c) => c.name === "metrics-db-reachable");
    expect(reachable).toBeDefined();
    expect(reachable!.presence.ok).toBe(false);
    expect(reachable!.presence.detail).toContain("Disabled");
    expect(reachable!.presence.detail).toContain("contextMode.enabled");
    expect(reachable!.presence.detail).not.toContain("/supi:context");
  });
});