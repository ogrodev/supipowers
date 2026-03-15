// tests/context-mode/event-store.test.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventStore, type EventCategory, type TrackedEvent } from "../../src/context-mode/event-store.js";

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
  overrides?: Partial<Omit<TrackedEvent, "id">>,
): Omit<TrackedEvent, "id"> {
  return {
    sessionId: "test-session",
    category,
    data,
    priority: "medium",
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
      event("error", '{"msg":"fail"}', { priority: "critical" }),
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
      event("file", "a", { priority: "low" }),
      event("error", "b", { priority: "critical" }),
    ]);
    const critical = store.getEvents("test-session", { priority: "critical" });
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
      event("git", '{"op":"commit","message":"fix parser bug"}'),
    ]);
    const results = store.searchEvents("test-session", "parser");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((e) => e.data.includes("parser"))).toBe(true);
  });

  test("getEventCounts returns correct counts", () => {
    store.writeEvents([
      event("file", "a"), event("file", "b"),
      event("git", "c"),
      event("error", "d"),
    ]);
    const counts = store.getEventCounts("test-session");
    expect(counts.file).toBe(2);
    expect(counts.git).toBe(1);
    expect(counts.error).toBe(1);
    expect(counts.cwd).toBe(0);
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
