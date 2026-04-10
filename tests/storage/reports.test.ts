import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createPaths } from "../../src/platform/types.js";
import { loadLatestReport, saveReviewReport } from "../../src/storage/reports.js";
import type { ReviewReport } from "../../src/types.js";

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

function createReport(overrides: Partial<ReviewReport> = {}): ReviewReport {
  return {
    timestamp: "2026-04-10T00:00:00.000Z",
    selectedGates: ["lsp-diagnostics"],
    gates: [
      {
        gate: "lsp-diagnostics",
        status: "passed",
        summary: "No diagnostics",
        issues: [],
      },
    ],
    summary: { passed: 1, failed: 0, skipped: 0, blocked: 0 },
    overallStatus: "passed",
    ...overrides,
  };
}

describe("review report storage", () => {
  let tmpDir: string;
  let localPaths: ReturnType<typeof createPaths>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-reports-test-"));
    localPaths = createTestPaths(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("saves and reloads review reports", () => {
    const report = createReport();

    saveReviewReport(localPaths, tmpDir, report);

    expect(loadLatestReport(localPaths, tmpDir)).toEqual(report);
  });

  test("loadLatestReport ignores legacy profile-shaped report files", () => {
    const reportsDir = localPaths.project(tmpDir, "reports");
    fs.mkdirSync(reportsDir, { recursive: true });
    fs.writeFileSync(
      path.join(reportsDir, "review-2026-04-10.json"),
      JSON.stringify({
        profile: "thorough",
        passed: true,
        gates: [],
        timestamp: "2026-04-10T00:00:00.000Z",
      }),
    );

    expect(loadLatestReport(localPaths, tmpDir)).toBeNull();
  });
});
