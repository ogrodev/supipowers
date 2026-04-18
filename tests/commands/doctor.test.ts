import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createPaths, type Platform } from "../../src/platform/types.js";
import { checkConfig, formatReliabilityReportLines } from "../../src/commands/doctor.js";
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