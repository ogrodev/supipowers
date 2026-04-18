// tests/context-mode/event-store.test.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  EventStore,
  PRIORITY,
  type EventCategory,
  type EventPriority,
  type TrackedEvent,
} from "../../src/context-mode/event-store.js";

let tmpDir: string;
let store: EventStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-events-"));
  store = new EventStore(path.join(tmpDir, "events.db"));
  store.init();
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function event(
  category: EventCategory,
  data: string,
  overrides?: Partial<Omit<TrackedEvent, "id" | "dataHash">>,
): Omit<TrackedEvent, "id" | "dataHash"> {
  return {
    sessionId: "test-session",
    category,
    data,
    priority: PRIORITY.medium,
    source: "tool_result",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("EventStore", () => {
  test("schema creation on init", () => {
    const events = store.getEvents("test-session");
    expect(events).toEqual([]);
  });

  test("writeEvent persists and is queryable", () => {
    store.writeEvent(event("file", '{"op":"read","path":"/test.ts"}'));
    const events = store.getEvents("test-session");
    expect(events).toHaveLength(1);
    expect(events[0].category).toBe("file");
    expect(events[0].data).toBe('{"op":"read","path":"/test.ts"}');
  });

  test("writeEvents writes multiple in single transaction", () => {
    store.writeEvents([
      event("file", '{"op":"read"}'),
      event("git", '{"op":"commit"}'),
      event("error", '{"msg":"fail"}', { priority: PRIORITY.critical }),
    ]);
    const events = store.getEvents("test-session");
    expect(events).toHaveLength(3);
  });

  test("getEvents filters by category", () => {
    store.writeEvents([
      event("file", "a"),
      event("git", "b"),
      event("file", "c"),
    ]);
    const files = store.getEvents("test-session", { categories: ["file"] });
    expect(files).toHaveLength(2);
    expect(files.every((e) => e.category === "file")).toBe(true);
  });

  test("getEvents filters by priority", () => {
    store.writeEvents([
      event("file", "a", { priority: PRIORITY.low }),
      event("error", "b", { priority: PRIORITY.critical }),
    ]);
    const critical = store.getEvents("test-session", { priority: PRIORITY.critical });
    expect(critical).toHaveLength(1);
    expect(critical[0].category).toBe("error");
  });

  test("getEvents filters by since timestamp", () => {
    const old = event("file", "old", { timestamp: 1000 });
    const recent = event("file", "recent", { timestamp: 2000 });
    store.writeEvents([old, recent]);
    const events = store.getEvents("test-session", { since: 1500 });
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("recent");
  });

  test("getEvents respects limit", () => {
    store.writeEvents([event("file", "a"), event("file", "b"), event("file", "c")]);
    const events = store.getEvents("test-session", { limit: 2 });
    expect(events).toHaveLength(2);
  });

  test("searchEvents uses FTS5", () => {
    store.writeEvents([
      event("file", '{"op":"read","path":"/src/utils/parser.ts"}'),
      event("file", '{"op":"write","path":"/src/index.ts"}'),
      event("git", '{"cmd":"git commit"}'),
    ]);
    const results = store.searchEvents("test-session", "parser");
    expect(results).toHaveLength(1);
    expect(results[0].data).toContain("parser.ts");
  });

  test("getEventCounts returns per-category counts", () => {
    store.writeEvents([
      event("file", "a"),
      event("file", "b"),
      event("git", "c"),
    ]);
    const counts = store.getEventCounts("test-session");
    expect(counts.file).toBe(2);
    expect(counts.git).toBe(1);
    expect(counts.error).toBe(0);
    // New categories initialized to 0
    expect(counts.rule).toBe(0);
    expect(counts.env).toBe(0);
    expect(counts.skill).toBe(0);
    expect(counts.intent).toBe(0);
  });

  test("pruneEvents deletes old events", () => {
    store.writeEvents([
      event("file", "old", { timestamp: 1000 }),
      event("file", "recent", { timestamp: 9999 }),
    ]);
    const pruned = store.pruneEvents(5000);
    expect(pruned).toBe(1);
    const remaining = store.getEvents("test-session");
    expect(remaining).toHaveLength(1);
    expect(remaining[0].data).toBe("recent");
  });

  test("isolates events by session", () => {
    store.writeEvent(event("file", "session-a", { sessionId: "a" }));
    store.writeEvent(event("file", "session-b", { sessionId: "b" }));
    expect(store.getEvents("a")).toHaveLength(1);
    expect(store.getEvents("b")).toHaveLength(1);
  });
});

describe("EventStore dedup", () => {
  test("skips duplicate event within dedup window", () => {
    store.writeEvent(event("file", '{"op":"read","path":"/test.ts"}'));
    store.writeEvent(event("file", '{"op":"read","path":"/test.ts"}'));
    const events = store.getEvents("test-session");
    expect(events).toHaveLength(1);
  });

  test("allows same data in different category", () => {
    store.writeEvent(event("file", '{"path":"/test.ts"}'));
    store.writeEvent(event("git", '{"path":"/test.ts"}'));
    const events = store.getEvents("test-session");
    expect(events).toHaveLength(2);
  });

  test("allows duplicate outside dedup window", () => {
    // Write 5 different events to push the first out of the window
    const first = event("file", '{"id":"first"}');
    store.writeEvent(first);
    for (let i = 0; i < 5; i++) {
      store.writeEvent(event("git", `{"i":${i}}`));
    }
    // Now re-write the first event — should succeed (outside 5-event window)
    store.writeEvent(event("file", '{"id":"first"}'));
    const fileEvents = store.getEvents("test-session", { categories: ["file"] });
    expect(fileEvents).toHaveLength(2);
  });

  test("dedup works within writeEvents batch", () => {
    store.writeEvents([
      event("file", '{"path":"a"}'),
      event("file", '{"path":"a"}'),
      event("file", '{"path":"b"}'),
    ]);
    const events = store.getEvents("test-session");
    expect(events).toHaveLength(2);
  });
});

describe("EventStore FIFO eviction", () => {
  test("enforces 1000-event cap per session", () => {
    // Write exactly 1000 events
    const batch = Array.from({ length: 1000 }, (_, i) =>
      event("file", `{"i":${i}}`),
    );
    store.writeEvents(batch);
    expect(store.getEvents("test-session", { limit: 1001 })).toHaveLength(1000);

    // Write one more — triggers eviction
    store.writeEvent(event("file", '{"i":"overflow"}'));
    expect(store.getEvents("test-session", { limit: 1001 })).toHaveLength(1000);
  });

  test("evicts lowest priority first", () => {
    // 999 high-priority events
    const highBatch = Array.from({ length: 999 }, (_, i) =>
      event("file", `{"high":${i}}`, { priority: PRIORITY.high }),
    );
    store.writeEvents(highBatch);

    // 1 lowest-priority event (the eviction target)
    store.writeEvent(event("mcp", '{"target":"evict-me"}', { priority: PRIORITY.lowest }));

    // 1 more high-priority event — triggers eviction
    store.writeEvent(event("file", '{"high":"trigger"}', { priority: PRIORITY.high }));

    // The lowest-priority event should be gone
    const mcp = store.getEvents("test-session", { categories: ["mcp"] });
    expect(mcp).toHaveLength(0);
    expect(store.getEvents("test-session", { limit: 1001 })).toHaveLength(1000);
  });
});

describe("EventStore session metadata", () => {
  test("upsertMeta creates new metadata", () => {
    store.upsertMeta("s1", "/project");
    const meta = store.getMeta("s1");
    expect(meta).not.toBeNull();
    expect(meta!.sessionId).toBe("s1");
    expect(meta!.projectDir).toBe("/project");
    expect(meta!.eventCount).toBe(0);
    expect(meta!.compactCount).toBe(0);
  });

  test("upsertMeta increments event count on conflict", () => {
    store.upsertMeta("s1", "/project");
    store.upsertMeta("s1", "/project");
    store.upsertMeta("s1", "/project");
    const meta = store.getMeta("s1");
    expect(meta!.eventCount).toBe(2); // First insert is 0, two updates add 1 each
  });

  test("incrementCompactCount bumps compact_count", () => {
    store.upsertMeta("s1", "/project");
    store.incrementCompactCount("s1");
    store.incrementCompactCount("s1");
    const meta = store.getMeta("s1");
    expect(meta!.compactCount).toBe(2);
  });

  test("getMeta returns null for unknown session", () => {
    expect(store.getMeta("nonexistent")).toBeNull();
  });
});

describe("EventStore resume snapshots", () => {
  test("upsertResume creates and retrieves snapshot", () => {
    store.upsertResume("s1", "<snapshot>data</snapshot>", 42);
    const resume = store.getResume("s1");
    expect(resume).not.toBeNull();
    expect(resume!.snapshot).toBe("<snapshot>data</snapshot>");
    expect(resume!.eventCount).toBe(42);
    expect(resume!.consumed).toBe(false);
  });

  test("upsertResume replaces existing snapshot", () => {
    store.upsertResume("s1", "old", 10);
    store.upsertResume("s1", "new", 20);
    const resume = store.getResume("s1");
    expect(resume!.snapshot).toBe("new");
    expect(resume!.eventCount).toBe(20);
  });

  test("consumeResume marks snapshot as consumed", () => {
    store.upsertResume("s1", "data", 5);
    store.consumeResume("s1");
    // getResume only returns unconsumed snapshots
    expect(store.getResume("s1")).toBeNull();
  });

  test("upsertResume after consume resets consumed flag", () => {
    store.upsertResume("s1", "first", 5);
    store.consumeResume("s1");
    store.upsertResume("s1", "second", 10);
    const resume = store.getResume("s1");
    expect(resume!.snapshot).toBe("second");
    expect(resume!.consumed).toBe(false);
  });

  test("getResume returns null for unknown session", () => {
    expect(store.getResume("nonexistent")).toBeNull();
  });
});

describe("EventStore pruneOldSessions", () => {
  test("removes old events and orphaned metadata", () => {
    // Create session with old events
    store.writeEvent(event("file", "old-data", { sessionId: "old", timestamp: 1000 }));
    store.upsertMeta("old", "/old-project");
    store.upsertResume("old", "old-snapshot", 1);

    // Create session with recent events (timestamp in the future to survive pruning)
    store.writeEvent(event("file", "new-data", { sessionId: "new", timestamp: Date.now() + 60_000 }));
    store.upsertMeta("new", "/new-project");

    // Prune with a cutoff that removes the old session
    const pruned = store.pruneOldSessions(0); // retention = 0 days
    expect(pruned).toBeGreaterThanOrEqual(1);

    // Old session metadata and resume should be cleaned up
    expect(store.getMeta("old")).toBeNull();
    expect(store.getResume("old")).toBeNull();

    // New session should remain
    expect(store.getMeta("new")).not.toBeNull();
    expect(store.getEvents("new")).toHaveLength(1);
  });
});

describe("EventStore schema migration", () => {
  test("migrates v0 schema to v1 (adds data_hash column)", () => {
    // Create a v0 database manually (no data_hash column)
    const dbPath = path.join(tmpDir, "v0.db");
    const db = new (require("bun:sqlite").Database)(dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(`
      CREATE TABLE session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        category TEXT NOT NULL,
        data TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'medium',
        source TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );
    `);
    // Insert a v0 event with string priority
    db.prepare(
      "INSERT INTO session_events (session_id, category, data, priority, source, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("s1", "file", '{"op":"read"}', "medium", "test", 1000);
    db.close();

    // Open with new EventStore — should migrate
    const migrated = new EventStore(dbPath);
    migrated.init();

    // Should be able to write new events (with data_hash)
    migrated.writeEvent({
      sessionId: "s1",
      category: "file",
      data: '{"op":"write"}',
      priority: PRIORITY.high,
      source: "test",
      timestamp: Date.now(),
    });

    // Old event (string priority) + new event should both be readable
    const events = migrated.getEvents("s1");
    expect(events.length).toBeGreaterThanOrEqual(2);

    // New tables should exist
    migrated.upsertMeta("s1", "/test");
    expect(migrated.getMeta("s1")).not.toBeNull();

    migrated.close();
  });
});


describe("EventStore edge cases", () => {
  test("close() disposes the database, new instance on same path works", () => {
    const dbPath = path.join(tmpDir, "closed.db");
    const s1 = new EventStore(dbPath);
    s1.init();
    s1.writeEvent(event("file", '{"op":"read"}'));
    s1.close();

    // Any subsequent operation on the closed store must throw.
    expect(() => s1.writeEvent(event("file", '{"op":"write"}'))).toThrow();

    // A fresh EventStore bound to the same file must still be usable,
    // and the previously-persisted event must remain readable.
    const s2 = new EventStore(dbPath);
    s2.init();
    const events = s2.getEvents("test-session");
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('{"op":"read"}');
    s2.close();
  });

  test("close() handles WAL sidecars without breaking repeated close or reopen", () => {
    const dbPath = path.join(tmpDir, "sidecars.db");
    const sidecars = [`${dbPath}-wal`, `${dbPath}-shm`];
    const sidecarStore = new EventStore(dbPath);
    sidecarStore.init();
    sidecarStore.writeEvent(event("file", '{"op":"read"}', { sessionId: "sidecar-session" }));

    expect(sidecars.some((file) => fs.existsSync(file))).toBe(true);

    sidecarStore.close();
    expect(() => sidecarStore.close()).not.toThrow();

    if (process.platform === "win32") {
      expect(sidecars.every((file) => !fs.existsSync(file))).toBe(true);
    } else {
      const reopened = new EventStore(dbPath);
      reopened.init();
      expect(reopened.getEvents("sidecar-session")).toHaveLength(1);
      reopened.close();
    }
  });


  test("searchEvents respects limit parameter", () => {
    const batch = Array.from({ length: 30 }, (_, i) =>
      event("file", `{"i":${i},"tag":"needle"}`),
    );
    store.writeEvents(batch);
    const results = store.searchEvents("test-session", "needle", 5);
    expect(results).toHaveLength(5);
  });

  test("searchEvents returns empty array when nothing matches", () => {
    store.writeEvents([
      event("file", '{"path":"a.ts"}'),
      event("git", '{"cmd":"status"}'),
    ]);
    const results = store.searchEvents("test-session", "zzznomatchzzz");
    expect(results).toEqual([]);
  });

  test("searchEvents with empty query does not crash process", () => {
    store.writeEvent(event("file", '{"path":"a.ts"}'));
    let threw = false;
    let results: unknown = null;
    try {
      results = store.searchEvents("test-session", "");
    } catch {
      threw = true;
    }
    // FTS5 may throw on an empty MATCH expression; either behavior is
    // acceptable as long as the store keeps working afterwards.
    expect(threw || Array.isArray(results)).toBe(true);
    // Store remains usable after an empty query.
    expect(store.getEvents("test-session")).toHaveLength(1);
  });

  test("pruneEvents with no matches returns 0 and preserves events", () => {
    const now = Date.now();
    store.writeEvents([
      event("file", "recent-a", { timestamp: now }),
      event("file", "recent-b", { timestamp: now + 1 }),
    ]);
    const pruned = store.pruneEvents(0);
    expect(pruned).toBe(0);
    expect(store.getEvents("test-session")).toHaveLength(2);
  });

  test("pruneOldSessions with no expired sessions returns 0 and preserves metadata", () => {
    store.writeEvent(event("file", "fresh", { timestamp: Date.now() }));
    store.upsertMeta("test-session", "/project");
    store.upsertResume("test-session", "snap", 1);

    const pruned = store.pruneOldSessions(7);
    expect(pruned).toBe(0);
    expect(store.getEvents("test-session")).toHaveLength(1);
    expect(store.getMeta("test-session")).not.toBeNull();
    expect(store.getResume("test-session")).not.toBeNull();
  });

  test("getEvents with empty categories array behaves as no-filter", () => {
    store.writeEvents([
      event("file", "a"),
      event("git", "b"),
      event("error", "c"),
    ]);
    // Source uses `filters?.categories?.length`, so `[]` is falsy and
    // no WHERE clause is added — all session events are returned.
    const results = store.getEvents("test-session", { categories: [] });
    expect(results).toHaveLength(3);
  });

  test("getEvents applies combined category + priority + since + limit filters", () => {
    store.writeEvents([
      event("file", "a", { priority: PRIORITY.high, timestamp: 1000 }),
      event("file", "b", { priority: PRIORITY.high, timestamp: 2000 }),
      event("file", "c", { priority: PRIORITY.high, timestamp: 3000 }),
      event("file", "d", { priority: PRIORITY.low,  timestamp: 4000 }),
      event("git",  "e", { priority: PRIORITY.high, timestamp: 5000 }),
    ]);
    const results = store.getEvents("test-session", {
      categories: ["file"],
      priority: PRIORITY.high,
      since: 1500,
      limit: 10,
    });
    // Only file + high + timestamp > 1500 qualify → b and c.
    // Order is DESC by timestamp.
    expect(results.map((e) => e.data)).toEqual(["c", "b"]);
  });

  test("getEventCounts for unknown session returns all 13 categories at 0", () => {
    const counts = store.getEventCounts("ghost");
    const keys = Object.keys(counts).sort();
    expect(keys).toEqual(
      [
        "cwd", "decision", "env", "error", "file", "git", "intent",
        "mcp", "prompt", "rule", "skill", "subagent", "task",
      ].sort(),
    );
    expect(keys).toHaveLength(13);
    for (const k of keys) {
      expect(counts[k as EventCategory]).toBe(0);
    }
  });

  test("upsertMeta preserves started_at across conflict", () => {
    store.upsertMeta("s1", "/project");
    const first = store.getMeta("s1");
    expect(first).not.toBeNull();
    expect(first!.startedAt).toBeTruthy();
    const firstStarted = first!.startedAt;

    store.upsertMeta("s1", "/project");
    store.upsertMeta("s1", "/project");
    const latest = store.getMeta("s1");
    expect(latest!.startedAt).toBe(firstStarted);
    // event_count was bumped twice → 2.
    expect(latest!.eventCount).toBe(2);
  });

  test("incrementCompactCount on non-existent session is a silent no-op", () => {
    expect(() => store.incrementCompactCount("ghost")).not.toThrow();
    expect(store.getMeta("ghost")).toBeNull();
  });
});

describe("EventStore multi-session behavior", () => {
  test("FIFO eviction is isolated per session", () => {
    // Fill session-a with 1000 lowest-priority events.
    const aBatch = Array.from({ length: 1000 }, (_, i) =>
      event("file", `{"a":${i}}`, {
        sessionId: "session-a",
        priority: PRIORITY.lowest,
        // Monotonic, distinct timestamps so ORDER BY timestamp ASC has a
        // deterministic victim on overflow (the very first one).
        timestamp: 1000 + i,
      }),
    );
    store.writeEvents(aBatch);
    expect(store.getEvents("session-a", { limit: 2000 })).toHaveLength(1000);

    // Write 10 high-priority events to session-b.
    const bBatch = Array.from({ length: 10 }, (_, i) =>
      event("file", `{"b":${i}}`, {
        sessionId: "session-b",
        priority: PRIORITY.high,
        timestamp: 5000 + i,
      }),
    );
    store.writeEvents(bBatch);
    expect(store.getEvents("session-b", { limit: 2000 })).toHaveLength(10);

    // Overflow session-a by one — must evict from session-a only.
    store.writeEvent(
      event("file", '{"a":"overflow"}', {
        sessionId: "session-a",
        priority: PRIORITY.lowest,
        timestamp: 9000,
      }),
    );

    // Session-a stays at 1000, session-b is untouched.
    expect(store.getEvents("session-a", { limit: 2000 })).toHaveLength(1000);
    expect(store.getEvents("session-b", { limit: 2000 })).toHaveLength(10);

    // The evicted row is the oldest lowest-priority row in session-a,
    // i.e. `{"a":0}` at timestamp 1000.
    const hits = store
      .getEvents("session-a", { limit: 2000 })
      .filter((e) => e.data === '{"a":0}');
    expect(hits).toHaveLength(0);

    // And the overflow event is present.
    const overflow = store
      .getEvents("session-a", { limit: 2000 })
      .filter((e) => e.data === '{"a":"overflow"}');
    expect(overflow).toHaveLength(1);
  });

  test("dedup key includes session_id", () => {
    const shared = '{"path":"/shared.ts"}';
    store.writeEvent(event("file", shared, { sessionId: "s-a" }));
    store.writeEvent(event("file", shared, { sessionId: "s-b" }));
    // Same data, different sessions — both must persist.
    expect(store.getEvents("s-a")).toHaveLength(1);
    expect(store.getEvents("s-b")).toHaveLength(1);

    // Re-writing to the same session within the dedup window is still
    // suppressed — confirms dedup is scoped, not globally disabled.
    store.writeEvent(event("file", shared, { sessionId: "s-a" }));
    expect(store.getEvents("s-a")).toHaveLength(1);
  });

  test("getEventCounts is scoped to a single session", () => {
    store.writeEvents([
      event("file", "a1", { sessionId: "s-a" }),
      event("file", "a2", { sessionId: "s-a" }),
      event("git",  "a3", { sessionId: "s-a" }),
    ]);
    store.writeEvents([
      event("error", "b1", { sessionId: "s-b", priority: PRIORITY.critical }),
    ]);

    const a = store.getEventCounts("s-a");
    expect(a.file).toBe(2);
    expect(a.git).toBe(1);
    expect(a.error).toBe(0);

    const b = store.getEventCounts("s-b");
    expect(b.file).toBe(0);
    expect(b.git).toBe(0);
    expect(b.error).toBe(1);
  });
});
