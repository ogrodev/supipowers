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
  getSessionDir,
} from "../../src/storage/qa-sessions.js";
import type { E2eSessionLedger } from "../../src/qa/types.js";
import { DEFAULT_E2E_QA_CONFIG } from "../../src/qa/config.js";

function makeLedger(overrides: Partial<E2eSessionLedger> = {}): E2eSessionLedger {
  return {
    id: "qa-20260311-120000-abcd",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    appType: "generic",
    baseUrl: "http://localhost:3000",
    phases: {
      "flow-discovery": { status: "pending" },
      "test-generation": { status: "pending" },
      "execution": { status: "pending" },
      "reporting": { status: "pending" },
    },
    flows: [],
    results: [],
    regressions: [],
    config: DEFAULT_E2E_QA_CONFIG,
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
    ledger.phases["flow-discovery"].status = "completed";
    ledger.updatedAt = new Date().toISOString();
    updateSession(tmpDir, ledger);
    expect(loadSession(tmpDir, ledger.id)?.phases["flow-discovery"].status).toBe("completed");
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
        "flow-discovery": { status: "completed" },
        "test-generation": { status: "completed" },
        "execution": { status: "pending" },
        "reporting": { status: "pending" },
      },
    });
    createSession(tmpDir, ledger);
    expect(findActiveSession(tmpDir)?.id).toBe("qa-20260311-120000-actv");
  });

  test("findActiveSession returns null when all phases completed", () => {
    const ledger = makeLedger({
      id: "qa-20260311-120000-done",
      phases: {
        "flow-discovery": { status: "completed" },
        "test-generation": { status: "completed" },
        "execution": { status: "completed" },
        "reporting": { status: "completed" },
      },
    });
    createSession(tmpDir, ledger);
    expect(findActiveSession(tmpDir)).toBeNull();
  });

  test("findSessionWithFailures returns session containing failed results", () => {
    const ledger = makeLedger({
      id: "qa-20260311-120000-fail",
      results: [
        { flowId: "login", testFile: "login.spec.ts", status: "pass", retryCount: 0 },
        { flowId: "signup", testFile: "signup.spec.ts", status: "fail", error: "boom", retryCount: 0 },
      ],
    });
    createSession(tmpDir, ledger);
    expect(findSessionWithFailures(tmpDir)?.id).toBe("qa-20260311-120000-fail");
  });

  test("findSessionWithFailures returns null when no failures", () => {
    const ledger = makeLedger({
      id: "qa-20260311-120000-pass",
      results: [
        { flowId: "login", testFile: "login.spec.ts", status: "pass", retryCount: 0 },
      ],
    });
    createSession(tmpDir, ledger);
    expect(findSessionWithFailures(tmpDir)).toBeNull();
  });

  test("getSessionDir returns correct path", () => {
    const dir = getSessionDir(tmpDir, "qa-20260311-120000-abcd");
    expect(dir).toBe(path.join(tmpDir, ".omp", "supipowers", "qa-sessions", "qa-20260311-120000-abcd"));
  });
});
