import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createPaths } from "../../src/platform/types.js";
import {
  createEmptyMatrix,
  detectRegressions,
  loadE2eMatrix,
  saveE2eMatrix,
  updateMatrixFromResults,
} from "../../src/qa/matrix.js";
import type { E2eFlowRecord, E2eTestResult } from "../../src/qa/types.js";
import type { WorkspaceTarget } from "../../src/types.js";

const paths = createPaths(".omp");

function target(name: string, relativeDir = "."): WorkspaceTarget {
  return {
    id: name,
    name,
    kind: relativeDir === "." ? "root" : "workspace",
    repoRoot: "/repo",
    packageDir: relativeDir === "." ? "/repo" : `/repo/${relativeDir}`,
    manifestPath: relativeDir === "." ? "/repo/package.json" : `/repo/${relativeDir}/package.json`,
    relativeDir,
    version: "1.0.0",
    private: false,
    packageManager: "bun",
  };
}

describe("E2E Matrix", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-matrix-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("createEmptyMatrix returns matrix with no flows", () => {
    const matrix = createEmptyMatrix("nextjs-app");
    expect(matrix.version).toBe("1.0.0");
    expect(matrix.appType).toBe("nextjs-app");
    expect(matrix.flows).toEqual([]);
    expect(matrix.updatedAt).toBeTruthy();
  });

  test("loadE2eMatrix returns null when no matrix exists", () => {
    expect(loadE2eMatrix(paths, tmpDir)).toBeNull();
  });

  test("saveE2eMatrix creates file and loadE2eMatrix reads it", () => {
    const matrix = createEmptyMatrix("vite");
    saveE2eMatrix(paths, tmpDir, matrix);

    const loaded = loadE2eMatrix(paths, tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.appType).toBe("vite");
  });

  test("workspace targets isolate matrices from root state", () => {
    const workspaceTarget = {
      ...target("@repo/web", "packages/web"),
      repoRoot: tmpDir,
      packageDir: path.join(tmpDir, "packages/web"),
      manifestPath: path.join(tmpDir, "packages/web/package.json"),
    };
    const matrix = createEmptyMatrix("nextjs-app");

    saveE2eMatrix(paths, tmpDir, matrix, workspaceTarget);

    expect(loadE2eMatrix(paths, tmpDir, workspaceTarget)).toEqual(matrix);
    expect(loadE2eMatrix(paths, tmpDir)).toBeNull();
    expect(fs.existsSync(path.join(tmpDir, ".omp", "supipowers", "workspaces", "packages", "web", "e2e-matrix.json"))).toBe(true);
  });

  test("loadE2eMatrix returns null for invalid JSON", () => {
    const matrixDir = path.join(tmpDir, ".omp", "supipowers");
    fs.mkdirSync(matrixDir, { recursive: true });
    fs.writeFileSync(path.join(matrixDir, "e2e-matrix.json"), "broken");
    expect(loadE2eMatrix(paths, tmpDir)).toBeNull();
  });

  test("detectRegressions finds pass-to-fail transitions", () => {
    const flows: E2eFlowRecord[] = [
      { id: "login", name: "Login", entryRoute: "/login", steps: [], priority: "critical", lastStatus: "pass", lastTestedAt: "2026-03-10T00:00:00Z", addedAt: "2026-03-01T00:00:00Z" },
      { id: "signup", name: "Signup", entryRoute: "/signup", steps: [], priority: "high", lastStatus: "fail", lastTestedAt: "2026-03-10T00:00:00Z", addedAt: "2026-03-01T00:00:00Z" },
      { id: "dashboard", name: "Dashboard", entryRoute: "/dashboard", steps: [], priority: "medium", lastStatus: "pass", lastTestedAt: "2026-03-10T00:00:00Z", addedAt: "2026-03-01T00:00:00Z" },
    ];

    const results: E2eTestResult[] = [
      { flowId: "login", testFile: "login.spec.ts", status: "fail", error: "Timeout", retryCount: 0 },
      { flowId: "signup", testFile: "signup.spec.ts", status: "fail", error: "Still broken", retryCount: 0 },
      { flowId: "dashboard", testFile: "dashboard.spec.ts", status: "pass", retryCount: 0 },
    ];

    const regressions = detectRegressions(flows, results);
    expect(regressions).toHaveLength(1);
    expect(regressions[0].flowId).toBe("login");
    expect(regressions[0].previousStatus).toBe("pass");
    expect(regressions[0].currentStatus).toBe("fail");
    expect(regressions[0].error).toBe("Timeout");
  });

  test("detectRegressions returns empty when no regressions", () => {
    const flows: E2eFlowRecord[] = [
      { id: "login", name: "Login", entryRoute: "/login", steps: [], priority: "critical", lastStatus: "pass", lastTestedAt: "2026-03-10T00:00:00Z", addedAt: "2026-03-01T00:00:00Z" },
    ];
    const results: E2eTestResult[] = [
      { flowId: "login", testFile: "login.spec.ts", status: "pass", retryCount: 0 },
    ];
    expect(detectRegressions(flows, results)).toEqual([]);
  });

  test("updateMatrixFromResults updates flow statuses and timestamps", () => {
    const matrix = createEmptyMatrix("nextjs-app");
    matrix.flows = [
      { id: "login", name: "Login", entryRoute: "/login", steps: [], priority: "critical", lastStatus: "untested", lastTestedAt: null, addedAt: "2026-03-01T00:00:00Z" },
      { id: "signup", name: "Signup", entryRoute: "/signup", steps: [], priority: "high", lastStatus: "pass", lastTestedAt: "2026-03-10T00:00:00Z", addedAt: "2026-03-01T00:00:00Z" },
    ];

    const results: E2eTestResult[] = [
      { flowId: "login", testFile: "login.spec.ts", status: "pass", retryCount: 0 },
      { flowId: "signup", testFile: "signup.spec.ts", status: "fail", error: "Element not found", retryCount: 0 },
    ];

    const updated = updateMatrixFromResults(matrix, results);
    const login = updated.flows.find((f) => f.id === "login")!;
    const signup = updated.flows.find((f) => f.id === "signup")!;

    expect(login.lastStatus).toBe("pass");
    expect(login.lastTestedAt).not.toBeNull();
    expect(signup.lastStatus).toBe("fail");
    expect(signup.lastError).toBe("Element not found");
  });

  test("updateMatrixFromResults ignores results for unknown flows", () => {
    const matrix = createEmptyMatrix("vite");
    matrix.flows = [
      { id: "login", name: "Login", entryRoute: "/login", steps: [], priority: "critical", lastStatus: "untested", lastTestedAt: null, addedAt: "2026-03-01T00:00:00Z" },
    ];

    const results: E2eTestResult[] = [
      { flowId: "login", testFile: "login.spec.ts", status: "pass", retryCount: 0 },
      { flowId: "unknown", testFile: "unknown.spec.ts", status: "fail", retryCount: 0 },
    ];

    const updated = updateMatrixFromResults(matrix, results);
    expect(updated.flows).toHaveLength(1);
    expect(updated.flows[0].lastStatus).toBe("pass");
  });
});
