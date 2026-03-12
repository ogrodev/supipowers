import { describe, test, expect } from "vitest";
import {
  generateFixPrSessionId,
  createFixPrSession,
  loadFixPrSession,
  updateFixPrSession,
  findActiveFixPrSession,
  getSessionDir,
} from "../../src/storage/fix-pr-sessions.js";
import type { FixPrSessionLedger } from "../../src/fix-pr/types.js";
import { DEFAULT_FIX_PR_CONFIG } from "../../src/fix-pr/config.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

function makeLedger(overrides?: Partial<FixPrSessionLedger>): FixPrSessionLedger {
  return {
    id: generateFixPrSessionId(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    prNumber: 42,
    repo: "owner/repo",
    status: "running",
    iteration: 0,
    config: DEFAULT_FIX_PR_CONFIG,
    commentsProcessed: [],
    ...overrides,
  };
}

describe("generateFixPrSessionId", () => {
  test("starts with fpr-", () => {
    const id = generateFixPrSessionId();
    expect(id.startsWith("fpr-")).toBe(true);
  });

  test("generates unique IDs", () => {
    const a = generateFixPrSessionId();
    const b = generateFixPrSessionId();
    expect(a).not.toBe(b);
  });

  test("matches expected format fpr-YYYYMMDD-HHMMSS-xxxx", () => {
    const id = generateFixPrSessionId();
    expect(id).toMatch(/^fpr-\d{8}-\d{6}-[a-z0-9]{4}$/);
  });
});

describe("session CRUD", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-fpr-sess-"));
    return tmpDir;
  }

  function cleanup() {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  test("createFixPrSession creates session directory and ledger", () => {
    setup();
    const ledger = makeLedger();
    createFixPrSession(tmpDir, ledger);
    const sessionDir = getSessionDir(tmpDir, ledger.id);
    expect(fs.existsSync(sessionDir)).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "ledger.json"))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "snapshots"))).toBe(true);
    cleanup();
  });

  test("loadFixPrSession reads ledger back", () => {
    setup();
    const ledger = makeLedger();
    createFixPrSession(tmpDir, ledger);
    const loaded = loadFixPrSession(tmpDir, ledger.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.prNumber).toBe(42);
    expect(loaded!.repo).toBe("owner/repo");
    cleanup();
  });

  test("loadFixPrSession returns null for missing session", () => {
    setup();
    const loaded = loadFixPrSession(tmpDir, "fpr-nonexistent");
    expect(loaded).toBeNull();
    cleanup();
  });

  test("updateFixPrSession overwrites ledger", () => {
    setup();
    const ledger = makeLedger();
    createFixPrSession(tmpDir, ledger);
    ledger.iteration = 2;
    ledger.commentsProcessed = [1, 2, 3];
    updateFixPrSession(tmpDir, ledger);
    const loaded = loadFixPrSession(tmpDir, ledger.id);
    expect(loaded!.iteration).toBe(2);
    expect(loaded!.commentsProcessed).toEqual([1, 2, 3]);
    cleanup();
  });

  test("findActiveFixPrSession finds running session", () => {
    setup();
    const ledger = makeLedger({ status: "running" });
    createFixPrSession(tmpDir, ledger);
    const found = findActiveFixPrSession(tmpDir);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(ledger.id);
    cleanup();
  });

  test("findActiveFixPrSession returns null when no running sessions", () => {
    setup();
    const ledger = makeLedger({ status: "completed" });
    createFixPrSession(tmpDir, ledger);
    const found = findActiveFixPrSession(tmpDir);
    expect(found).toBeNull();
    cleanup();
  });

  test("getSessionDir returns correct path", () => {
    setup();
    const dir = getSessionDir(tmpDir, "fpr-20260312-143000-a1b2");
    expect(dir).toContain("fix-pr-sessions");
    expect(dir).toContain("fpr-20260312-143000-a1b2");
    cleanup();
  });
});
