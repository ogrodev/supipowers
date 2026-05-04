import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { rmDirWithRetry } from "../helpers/fs.js";
import { MemoryStore } from "../../src/context-mode/memory-store.js";

let tmpDir: string;
let store: MemoryStore;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-memory-"));
  dbPath = path.join(tmpDir, "memory.db");
  store = new MemoryStore({ dbPath, projectSlug: "demo" });
  store.init();
});

afterEach(() => {
  store.close();
  rmDirWithRetry(tmpDir);
});

describe("MemoryStore", () => {
  test("put deduplicates by owner+type+body and retains earliest high priority", () => {
    const first = store.put({
      ownerScope: "session",
      ownerId: "session-a",
      type: "decision",
      body: "Use TDD for retries",
      priority: 2,
      now: 1000,
    });
    const second = store.put({
      ownerScope: "session",
      ownerId: "session-a",
      type: "decision",
      body: "Use TDD for retries",
      priority: 4,
      now: 2000,
    });

    expect(first?.id).toBe(second?.id ?? -1);
    expect(second?.priority).toBe(2);
    expect(second?.createdAt).toBe(2000);
    expect(store.getStats().totalRows).toBe(1);
  });

  test("retrieve excludes other-session memory and respects byte budget", () => {
    store.put({ ownerScope: "session", ownerId: "session-a", type: "observation", body: "active session note", now: 1000 });
    store.put({ ownerScope: "session", ownerId: "session-b", type: "observation", body: "other session note", now: 2000 });
    store.put({ ownerScope: "project", type: "decision", body: "shared project decision", now: 3000 });

    const rows = store.retrieve({ sessionId: "session-a", byteBudget: 256 });
    const bodies = rows.map((row) => row.body).sort();
    expect(bodies).toEqual(["active session note", "shared project decision"]);

    const tinyBudget = store.retrieve({ sessionId: "session-a", byteBudget: 0 });
    expect(tinyBudget).toEqual([]);
  });

  test("clearSession deletes session-owned rows and writes a clear epoch", () => {
    store.put({ ownerScope: "session", ownerId: "session-a", type: "observation", body: "session note", now: 100 });
    store.put({ ownerScope: "project", type: "decision", body: "old project decision", now: 200 });

    store.clearSession("session-a", 500);

    expect(store.getStats()).toEqual({ totalRows: 1, sessionRows: 0, projectRows: 1 });

    // After clear, project memory created before the epoch is suppressed for session-a.
    const afterClear = store.retrieve({ sessionId: "session-a" });
    expect(afterClear).toEqual([]);

    // New project memory after the clear is visible again.
    store.put({ ownerScope: "project", type: "decision", body: "fresh project decision", now: 600 });
    const fresh = store.retrieve({ sessionId: "session-a" });
    expect(fresh.map((row) => row.body)).toEqual(["fresh project decision"]);
  });

  test("clearSession suppresses project rows created at the exact clear epoch", () => {
    store.put({ ownerScope: "project", type: "decision", body: "same millisecond project decision", now: 500 });

    store.clearSession("session-a", 500);

    expect(store.retrieve({ sessionId: "session-a" })).toEqual([]);
    store.put({ ownerScope: "project", type: "decision", body: "after clear project decision", now: 501 });
    expect(store.retrieve({ sessionId: "session-a" }).map((row) => row.body)).toEqual([
      "after clear project decision",
    ]);
  });

  test("clearProject deletes everything including clear epochs", () => {
    store.put({ ownerScope: "session", ownerId: "session-a", type: "observation", body: "note" });
    store.put({ ownerScope: "project", type: "decision", body: "decision" });
    store.recordClearEpoch("session-a", 12345);

    const result = store.clearProject(99999);
    expect(result.deleted).toBeGreaterThanOrEqual(2);
    expect(store.getStats()).toEqual({ totalRows: 0, sessionRows: 0, projectRows: 0 });

    // Recording new memory works after project clear and is visible again.
    store.put({ ownerScope: "session", ownerId: "session-a", type: "observation", body: "fresh", now: 100000 });
    expect(store.retrieve({ sessionId: "session-a" }).map((r) => r.body)).toEqual(["fresh"]);
  });

  test("pruneOld removes rows older than retention", () => {
    const now = 10_000_000;
    store.put({ ownerScope: "project", type: "observation", body: "ancient", now: now - 90 * 24 * 60 * 60 * 1000 });
    store.put({ ownerScope: "project", type: "observation", body: "recent", now: now - 1000 });

    const deleted = store.pruneOld(7, now);
    expect(deleted).toBe(1);
    expect(store.getStats().projectRows).toBe(1);
  });

  test("countSessionRows is scoped to a single sessionId (F7: clear summary truthfulness)", () => {
    store.put({ ownerScope: "session", ownerId: "session-a", type: "observation", body: "a1" });
    store.put({ ownerScope: "session", ownerId: "session-a", type: "observation", body: "a2" });
    store.put({ ownerScope: "session", ownerId: "session-b", type: "observation", body: "b1" });
    store.put({ ownerScope: "project", type: "decision", body: "p1" });

    expect(store.countSessionRows("session-a")).toBe(2);
    expect(store.countSessionRows("session-b")).toBe(1);
    expect(store.countSessionRows("session-unknown")).toBe(0);
    // The project-wide stat must remain different.
    expect(store.getStats().sessionRows).toBe(3);
  });

  test("listSessions returns session-owned memory counts", () => {
    store.put({ ownerScope: "session", ownerId: "session-a", type: "observation", body: "a1" });
    store.put({ ownerScope: "session", ownerId: "session-a", type: "observation", body: "a2" });
    store.put({ ownerScope: "session", ownerId: "session-b", type: "observation", body: "b1" });
    store.put({ ownerScope: "project", type: "decision", body: "project" });

    expect(store.listSessions()).toEqual([
      { session_id: "session-a", row_count: 2 },
      { session_id: "session-b", row_count: 1 },
    ]);
  });
});
