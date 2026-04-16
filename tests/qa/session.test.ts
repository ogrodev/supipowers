import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createPaths } from "../../src/platform/types.js";
import { DEFAULT_E2E_QA_CONFIG } from "../../src/qa/config.js";
import {
  advanceE2ePhase,
  createNewE2eSession,
  getE2ePhaseStatusLine,
  getNextE2ePhase,
} from "../../src/qa/session.js";
import type { E2eSessionLedger } from "../../src/qa/types.js";
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

describe("E2E QA session lifecycle", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-e2e-session-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("createNewE2eSession initializes all phases as pending", () => {
    const ledger = createNewE2eSession(paths, tmpDir, DEFAULT_E2E_QA_CONFIG);
    expect(ledger.appType).toBe("generic");
    expect(ledger.baseUrl).toBe("http://localhost:3000");
    expect(ledger.id).toMatch(/^qa-/);
    expect(ledger.flows).toEqual([]);
    expect(ledger.results).toEqual([]);
    expect(ledger.regressions).toEqual([]);
    for (const phase of ["flow-discovery", "test-generation", "execution", "reporting"] as const) {
      expect(ledger.phases[phase].status).toBe("pending");
    }
  });

  test("createNewE2eSession persists ledger and creates subdirs", () => {
    const ledger = createNewE2eSession(paths, tmpDir, DEFAULT_E2E_QA_CONFIG);
    const sessionDir = path.join(tmpDir, ".omp", "supipowers", "qa-sessions", ledger.id);
    expect(fs.existsSync(path.join(sessionDir, "ledger.json"))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "tests"))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "screenshots"))).toBe(true);
  });

  test("workspace sessions create subdirs under the workspace state tree", () => {
    const workspaceTarget = {
      ...target("@repo/web", "packages/web"),
      repoRoot: tmpDir,
      packageDir: path.join(tmpDir, "packages/web"),
      manifestPath: path.join(tmpDir, "packages/web/package.json"),
    };
    const ledger = createNewE2eSession(paths, tmpDir, DEFAULT_E2E_QA_CONFIG, workspaceTarget);
    const sessionDir = path.join(tmpDir, ".omp", "supipowers", "workspaces", "packages", "web", "qa-sessions", ledger.id);
    expect(fs.existsSync(path.join(sessionDir, "ledger.json"))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "tests"))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "screenshots"))).toBe(true);
  });

  test("advanceE2ePhase updates status and timestamps", () => {
    const ledger = createNewE2eSession(paths, tmpDir, DEFAULT_E2E_QA_CONFIG);
    const updated = advanceE2ePhase(paths, tmpDir, ledger, "flow-discovery", "running");
    expect(updated.phases["flow-discovery"].status).toBe("running");
    expect(updated.phases["flow-discovery"].startedAt).toBeDefined();
    expect(updated.phases["flow-discovery"].completedAt).toBeUndefined();

    const completed = advanceE2ePhase(paths, tmpDir, updated, "flow-discovery", "completed");
    expect(completed.phases["flow-discovery"].status).toBe("completed");
    expect(completed.phases["flow-discovery"].completedAt).toBeDefined();
  });

  test("advanceE2ePhase persists changes to disk", () => {
    const ledger = createNewE2eSession(paths, tmpDir, DEFAULT_E2E_QA_CONFIG);
    advanceE2ePhase(paths, tmpDir, ledger, "flow-discovery", "completed");
    const filePath = path.join(tmpDir, ".omp", "supipowers", "qa-sessions", ledger.id, "ledger.json");
    const loaded = JSON.parse(fs.readFileSync(filePath, "utf-8")) as E2eSessionLedger;
    expect(loaded.phases["flow-discovery"].status).toBe("completed");
  });

  test("getNextE2ePhase returns first non-completed phase", () => {
    const ledger = createNewE2eSession(paths, tmpDir, DEFAULT_E2E_QA_CONFIG);
    expect(getNextE2ePhase(ledger)).toBe("flow-discovery");

    ledger.phases["flow-discovery"].status = "completed";
    expect(getNextE2ePhase(ledger)).toBe("test-generation");

    ledger.phases["test-generation"].status = "completed";
    ledger.phases.execution.status = "completed";
    expect(getNextE2ePhase(ledger)).toBe("reporting");

    ledger.phases.reporting.status = "completed";
    expect(getNextE2ePhase(ledger)).toBeNull();
  });

  test("getE2ePhaseStatusLine formats phase status for display", () => {
    const ledger = createNewE2eSession(paths, tmpDir, DEFAULT_E2E_QA_CONFIG);
    ledger.phases["flow-discovery"].status = "completed";
    ledger.phases["test-generation"].status = "completed";
    const line = getE2ePhaseStatusLine(ledger);
    expect(line).toContain("[done] Discovery");
    expect(line).toContain("[done] Generation");
    expect(line).toContain("[ ] Execution");
    expect(line).toContain("[ ] Reporting");
  });
});
