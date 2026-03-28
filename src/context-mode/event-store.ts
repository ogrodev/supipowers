// src/context-mode/event-store.ts
import { Database } from "bun:sqlite";

/** Event categories extracted from tool results */
export type EventCategory =
  | "file"
  | "git"
  | "error"
  | "task"
  | "cwd"
  | "mcp"
  | "subagent"
  | "prompt"
  | "decision";

/** Priority levels for resume snapshot ordering */
export type EventPriority = "critical" | "high" | "medium" | "low";

/** A tracked event */
export interface TrackedEvent {
  id?: number;
  sessionId: string;
  category: EventCategory;
  data: string;
  priority: EventPriority;
  source: string;
  timestamp: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS session_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  category TEXT NOT NULL,
  data TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'medium',
  source TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_session ON session_events(session_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_events_category ON session_events(session_id, category);

CREATE VIRTUAL TABLE IF NOT EXISTS session_events_fts USING fts5(
  data,
  content=session_events,
  content_rowid=id
);

CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON session_events BEGIN
  INSERT INTO session_events_fts(rowid, data) VALUES (new.id, new.data);
END;

CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON session_events BEGIN
  INSERT INTO session_events_fts(session_events_fts, rowid, data) VALUES ('delete', old.id, old.data);
END;

CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE ON session_events BEGIN
  INSERT INTO session_events_fts(session_events_fts, rowid, data) VALUES ('delete', old.id, old.data);
  INSERT INTO session_events_fts(rowid, data) VALUES (new.id, new.data);
END;
`;

const ALL_CATEGORIES: EventCategory[] = [
  "file", "git", "error", "task", "cwd", "mcp", "subagent", "prompt", "decision",
];

export class EventStore {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
  }

  init(): void {
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  writeEvent(event: Omit<TrackedEvent, "id">): void {
    this.db.prepare(
      "INSERT INTO session_events (session_id, category, data, priority, source, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(event.sessionId, event.category, event.data, event.priority, event.source, event.timestamp);
  }

  writeEvents(events: Omit<TrackedEvent, "id">[]): void {
    const insert = this.db.prepare(
      "INSERT INTO session_events (session_id, category, data, priority, source, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const tx = this.db.transaction(() => {
      for (const event of events) {
        insert.run(event.sessionId, event.category, event.data, event.priority, event.source, event.timestamp);
      }
    });
    tx();
  }

  getEvents(
    sessionId: string,
    filters?: {
      categories?: EventCategory[];
      priority?: EventPriority;
      since?: number;
      limit?: number;
    },
  ): TrackedEvent[] {
    const conditions = ["session_id = ?"];
    const params: (string | number)[] = [sessionId];

    if (filters?.categories?.length) {
      conditions.push(`category IN (${filters.categories.map(() => "?").join(",")})`);
      params.push(...filters.categories);
    }
    if (filters?.priority) {
      conditions.push("priority = ?");
      params.push(filters.priority);
    }
    if (filters?.since) {
      conditions.push("timestamp > ?");
      params.push(filters.since);
    }

    let sql = `SELECT id, session_id AS sessionId, category, data, priority, source, timestamp FROM session_events WHERE ${conditions.join(" AND ")} ORDER BY timestamp DESC`;

    if (filters?.limit) {
      sql += " LIMIT ?";
      params.push(filters.limit);
    }

    return this.db.prepare(sql).all(...params) as TrackedEvent[];
  }

  searchEvents(sessionId: string, query: string, limit = 20): TrackedEvent[] {
    const sql = `
      SELECT e.id, e.session_id AS sessionId, e.category, e.data, e.priority, e.source, e.timestamp
      FROM session_events_fts fts
      JOIN session_events e ON e.id = fts.rowid
      WHERE fts.data MATCH ? AND e.session_id = ?
      ORDER BY rank
      LIMIT ?
    `;
    return this.db.prepare(sql).all(query, sessionId, limit) as TrackedEvent[];
  }

  getEventCounts(sessionId: string): Record<EventCategory, number> {
    const rows = this.db.prepare(
      "SELECT category, COUNT(*) AS count FROM session_events WHERE session_id = ? GROUP BY category",
    ).all(sessionId) as Array<{ category: EventCategory; count: number }>;

    const counts = {} as Record<EventCategory, number>;
    for (const cat of ALL_CATEGORIES) counts[cat] = 0;
    for (const row of rows) counts[row.category] = row.count;
    return counts;
  }

  pruneEvents(olderThan: number): number {
    const countRow = this.db.prepare("SELECT COUNT(*) AS count FROM session_events WHERE timestamp < ?").get(olderThan) as { count: number };
    if (countRow.count > 0) {
      this.db.prepare("DELETE FROM session_events WHERE timestamp < ?").run(olderThan);
    }
    return countRow.count;
  }

  close(): void {
    this.db.close();
  }
}
