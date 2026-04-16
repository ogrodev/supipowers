import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createPaths } from "../../src/platform/types.js";
import { loadLatestReport, saveReviewReport } from "../../src/storage/reports.js";
import type { ReviewReport, WorkspaceTarget } from "../../src/types.js";

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

function createTarget(overrides: Partial<WorkspaceTarget> = {}): WorkspaceTarget {
  const repoRoot = overrides.repoRoot ?? "/repo";
  const relativeDir = overrides.relativeDir ?? ".";
  const packageDir = overrides.packageDir ?? (relativeDir === "." ? repoRoot : `${repoRoot}/${relativeDir}`);

  return {
    id: overrides.id ?? (relativeDir === "." ? "root-app" : `pkg:${relativeDir}`),
    name: overrides.name ?? (relativeDir === "." ? "root-app" : `pkg:${relativeDir}`),
    kind: overrides.kind ?? (relativeDir === "." ? "root" : "workspace"),
    repoRoot,
    packageDir,
    manifestPath: overrides.manifestPath ?? `${packageDir}/package.json`,
    relativeDir,
    version: overrides.version ?? "1.0.0",
    private: overrides.private ?? false,
    packageManager: overrides.packageManager ?? "bun",
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
  let rootTarget: WorkspaceTarget;
  let workspaceTarget: WorkspaceTarget;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-reports-test-"));
    localPaths = createTestPaths(tmpDir);
    rootTarget = createTarget({ repoRoot: tmpDir });
    workspaceTarget = createTarget({
      repoRoot: tmpDir,
      id: "@repo/pkg",
      name: "@repo/pkg",
      kind: "workspace",
      relativeDir: "packages/pkg",
      packageDir: path.join(tmpDir, "packages/pkg"),
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("saves and reloads review reports", () => {
    const report = createReport();

    saveReviewReport(localPaths, rootTarget, report);

    expect(loadLatestReport(localPaths, rootTarget)).toEqual(report);
  });

  test("isolates workspace reports from root reports", () => {
    const rootReport = createReport({ timestamp: "2026-04-10T00:00:00.000Z" });
    const workspaceReport = createReport({ timestamp: "2026-04-11T00:00:00.000Z" });

    const rootPath = saveReviewReport(localPaths, rootTarget, rootReport);
    const workspacePath = saveReviewReport(localPaths, workspaceTarget, workspaceReport);

    expect(rootPath).toContain(path.join(".omp", "supipowers", "reports"));
    expect(workspacePath).toContain(path.join(".omp", "supipowers", "workspaces", "packages", "pkg", "reports"));
    expect(loadLatestReport(localPaths, rootTarget)).toEqual(rootReport);
    expect(loadLatestReport(localPaths, workspaceTarget)).toEqual(workspaceReport);
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

    expect(loadLatestReport(localPaths, rootTarget)).toBeNull();
  });
});
