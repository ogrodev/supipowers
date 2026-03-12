import { describe, test, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  createNewSession,
  advancePhase,
  mergeTestResults,
  getFailedTests,
  getNextPhase,
  getPhaseStatusLine,
} from "../../src/qa/session.js";
import type { QaSessionLedger, QaTestResult } from "../../src/types.js";

describe("qa session lifecycle", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-session-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("createNewSession initializes all phases as pending", () => {
    const ledger = createNewSession(tmpDir, "vitest");
    expect(ledger.framework).toBe("vitest");
    expect(ledger.id).toMatch(/^qa-/);
    expect(ledger.tests).toEqual([]);
    expect(ledger.matrix).toEqual([]);
    expect(ledger.results).toEqual([]);
    for (const phase of ["discovery", "matrix", "execution", "reporting"] as const) {
      expect(ledger.phases[phase].status).toBe("pending");
    }
  });

  test("createNewSession persists the ledger to disk", () => {
    const ledger = createNewSession(tmpDir, "jest");
    const filePath = path.join(tmpDir, ".omp", "supipowers", "qa-sessions", ledger.id, "ledger.json");
    expect(fs.existsSync(filePath)).toBe(true);
  });

  test("advancePhase updates status and timestamps", () => {
    const ledger = createNewSession(tmpDir, "vitest");
    const updated = advancePhase(tmpDir, ledger, "discovery", "running");
    expect(updated.phases.discovery.status).toBe("running");
    expect(updated.phases.discovery.startedAt).toBeDefined();
    expect(updated.phases.discovery.completedAt).toBeUndefined();

    const completed = advancePhase(tmpDir, updated, "discovery", "completed");
    expect(completed.phases.discovery.status).toBe("completed");
    expect(completed.phases.discovery.completedAt).toBeDefined();
  });

  test("advancePhase persists changes to disk", () => {
    const ledger = createNewSession(tmpDir, "vitest");
    advancePhase(tmpDir, ledger, "discovery", "completed");
    const filePath = path.join(tmpDir, ".omp", "supipowers", "qa-sessions", ledger.id, "ledger.json");
    const loaded = JSON.parse(fs.readFileSync(filePath, "utf-8")) as QaSessionLedger;
    expect(loaded.phases.discovery.status).toBe("completed");
  });

  test("mergeTestResults inserts new results", () => {
    const ledger = createNewSession(tmpDir, "vitest");
    const newResults: QaTestResult[] = [
      { testId: "t1", status: "pass", retryCount: 0, lastRunAt: new Date().toISOString() },
      { testId: "t2", status: "fail", retryCount: 0, lastRunAt: new Date().toISOString(), error: "boom" },
    ];
    const updated = mergeTestResults(ledger, newResults);
    expect(updated.results).toHaveLength(2);
    expect(updated.results.find((r) => r.testId === "t1")?.status).toBe("pass");
    expect(updated.results.find((r) => r.testId === "t2")?.status).toBe("fail");
  });

  test("mergeTestResults upserts existing results and increments retryCount", () => {
    const ledger = createNewSession(tmpDir, "vitest");
    ledger.results = [
      { testId: "t1", status: "fail", retryCount: 0, lastRunAt: "2026-03-11T10:00:00Z", error: "old error" },
      { testId: "t2", status: "pass", retryCount: 0, lastRunAt: "2026-03-11T10:00:00Z" },
    ];
    const newResults: QaTestResult[] = [
      { testId: "t1", status: "pass", retryCount: 0, lastRunAt: "2026-03-11T11:00:00Z" },
    ];
    const updated = mergeTestResults(ledger, newResults);
    expect(updated.results).toHaveLength(2);
    const t1 = updated.results.find((r) => r.testId === "t1")!;
    expect(t1.status).toBe("pass");
    expect(t1.retryCount).toBe(1);
    expect(t1.error).toBeUndefined();
    // t2 untouched
    expect(updated.results.find((r) => r.testId === "t2")?.retryCount).toBe(0);
  });

  test("getFailedTests returns test cases whose result is fail", () => {
    const ledger = createNewSession(tmpDir, "vitest");
    ledger.tests = [
      { id: "t1", filePath: "a.test.ts", testName: "test one" },
      { id: "t2", filePath: "b.test.ts", testName: "test two" },
      { id: "t3", filePath: "c.test.ts", testName: "test three" },
    ];
    ledger.results = [
      { testId: "t1", status: "pass", retryCount: 0, lastRunAt: new Date().toISOString() },
      { testId: "t2", status: "fail", retryCount: 0, lastRunAt: new Date().toISOString(), error: "boom" },
      { testId: "t3", status: "fail", retryCount: 1, lastRunAt: new Date().toISOString(), error: "crash" },
    ];
    const failed = getFailedTests(ledger);
    expect(failed).toHaveLength(2);
    expect(failed.map((t) => t.id)).toEqual(["t2", "t3"]);
  });

  test("getFailedTests returns empty array when no failures", () => {
    const ledger = createNewSession(tmpDir, "vitest");
    ledger.results = [
      { testId: "t1", status: "pass", retryCount: 0, lastRunAt: new Date().toISOString() },
    ];
    expect(getFailedTests(ledger)).toEqual([]);
  });

  test("getNextPhase returns first non-completed phase", () => {
    const ledger = createNewSession(tmpDir, "vitest");
    expect(getNextPhase(ledger)).toBe("discovery");

    ledger.phases.discovery.status = "completed";
    expect(getNextPhase(ledger)).toBe("matrix");

    ledger.phases.matrix.status = "completed";
    ledger.phases.execution.status = "completed";
    expect(getNextPhase(ledger)).toBe("reporting");

    ledger.phases.reporting.status = "completed";
    expect(getNextPhase(ledger)).toBeNull();
  });

  test("getPhaseStatusLine formats phase status for display", () => {
    const ledger = createNewSession(tmpDir, "vitest");
    ledger.phases.discovery.status = "completed";
    ledger.phases.matrix.status = "completed";
    const line = getPhaseStatusLine(ledger);
    expect(line).toContain("Discovery");
    expect(line).toContain("Matrix");
    expect(line).toContain("Execution");
    expect(line).toContain("Reporting");
  });
});
