import { describe, test, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  generateSessionId,
  createSession,
  loadSession,
  updateSession,
  listSessions,
  findActiveSession,
  findSessionWithFailures,
} from "../../src/storage/qa-sessions.js";
import type { QaSessionLedger } from "../../src/types.js";

function makeLedger(overrides: Partial<QaSessionLedger> = {}): QaSessionLedger {
  return {
    id: "qa-20260311-120000-abcd",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    framework: "vitest",
    phases: {
      discovery: { status: "pending" },
      matrix: { status: "pending" },
      execution: { status: "pending" },
      reporting: { status: "pending" },
    },
    tests: [],
    matrix: [],
    results: [],
    ...overrides,
  };
}

describe("qa-sessions storage", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-qa-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("generateSessionId returns expected format", () => {
    const id = generateSessionId();
    expect(id).toMatch(/^qa-\d{8}-\d{6}-[a-z0-9]{4}$/);
  });

  test("generateSessionId produces unique IDs", () => {
    const ids = new Set(Array.from({ length: 10 }, () => generateSessionId()));
    expect(ids.size).toBe(10);
  });

  test("createSession and loadSession roundtrip", () => {
    const ledger = makeLedger();
    createSession(tmpDir, ledger);
    const loaded = loadSession(tmpDir, ledger.id);
    expect(loaded).toEqual(ledger);
  });

  test("loadSession returns null for missing session", () => {
    expect(loadSession(tmpDir, "qa-nonexistent")).toBeNull();
  });

  test("updateSession persists changes", () => {
    const ledger = makeLedger();
    createSession(tmpDir, ledger);
    ledger.phases.discovery.status = "completed";
    ledger.updatedAt = new Date().toISOString();
    updateSession(tmpDir, ledger);
    expect(loadSession(tmpDir, ledger.id)?.phases.discovery.status).toBe("completed");
  });

  test("listSessions returns sessions sorted newest-first", () => {
    createSession(tmpDir, makeLedger({ id: "qa-20260310-100000-aaaa" }));
    createSession(tmpDir, makeLedger({ id: "qa-20260311-100000-bbbb" }));
    createSession(tmpDir, makeLedger({ id: "qa-20260309-100000-cccc" }));
    const list = listSessions(tmpDir);
    expect(list).toEqual([
      "qa-20260311-100000-bbbb",
      "qa-20260310-100000-aaaa",
      "qa-20260309-100000-cccc",
    ]);
  });

  test("listSessions returns empty array when no sessions exist", () => {
    expect(listSessions(tmpDir)).toEqual([]);
  });

  test("findActiveSession returns session with incomplete phases", () => {
    const ledger = makeLedger({
      id: "qa-20260311-120000-actv",
      phases: {
        discovery: { status: "completed" },
        matrix: { status: "completed" },
        execution: { status: "pending" },
        reporting: { status: "pending" },
      },
    });
    createSession(tmpDir, ledger);
    expect(findActiveSession(tmpDir)?.id).toBe("qa-20260311-120000-actv");
  });

  test("findActiveSession returns null when all phases completed", () => {
    const ledger = makeLedger({
      id: "qa-20260311-120000-done",
      phases: {
        discovery: { status: "completed" },
        matrix: { status: "completed" },
        execution: { status: "completed" },
        reporting: { status: "completed" },
      },
    });
    createSession(tmpDir, ledger);
    expect(findActiveSession(tmpDir)).toBeNull();
  });

  test("findSessionWithFailures returns session containing failed tests", () => {
    const ledger = makeLedger({
      id: "qa-20260311-120000-fail",
      results: [
        { testId: "t1", status: "pass", retryCount: 0, lastRunAt: new Date().toISOString() },
        { testId: "t2", status: "fail", retryCount: 0, lastRunAt: new Date().toISOString(), error: "boom" },
      ],
    });
    createSession(tmpDir, ledger);
    expect(findSessionWithFailures(tmpDir)?.id).toBe("qa-20260311-120000-fail");
  });

  test("findSessionWithFailures returns null when no failures", () => {
    const ledger = makeLedger({
      id: "qa-20260311-120000-pass",
      results: [
        { testId: "t1", status: "pass", retryCount: 0, lastRunAt: new Date().toISOString() },
      ],
    });
    createSession(tmpDir, ledger);
    expect(findSessionWithFailures(tmpDir)).toBeNull();
  });

  test("findSessionWithFailures returns null when no results yet", () => {
    createSession(tmpDir, makeLedger({ id: "qa-20260311-120000-nores" }));
    expect(findSessionWithFailures(tmpDir)).toBeNull();
  });
});
