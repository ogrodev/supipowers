// src/context-mode/event-store.ts
import { constants, Database } from "bun:sqlite";
import { createHash } from "node:crypto";

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
  | "decision"
  | "rule"
  | "env"
  | "skill"
  | "intent";

/** Numeric priority: 1 = critical … 5 = lowest */
export type EventPriority = 1 | 2 | 3 | 4 | 5;

/** Named priority constants — use instead of magic numbers */
export const PRIORITY = {
  critical: 1,
  high: 2,
  medium: 3,
  low: 4,
  lowest: 5,
} as const satisfies Record<string, EventPriority>;

/** A tracked event */
export interface TrackedEvent {
  id?: number;
  sessionId: string;
  category: EventCategory;
  data: string;
  priority: EventPriority;
  source: string;
  timestamp: number;
  dataHash?: string;
}

/** Session metadata row */
export interface SessionMeta {
  sessionId: string;
  projectDir: string;
  startedAt: string;
  lastEventAt: string;
  eventCount: number;
  compactCount: number;
}

/** Resume snapshot row */
export interface SessionResume {
  sessionId: string;
  snapshot: string;
  eventCount: number;
  createdAt: string;
  consumed: boolean;
}

const MAX_EVENTS_PER_SESSION = 1000;
const DEDUP_WINDOW = 5;
const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS session_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  category TEXT NOT NULL,
  data TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 3,
  source TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  data_hash TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_events_session ON session_events(session_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_events_category ON session_events(session_id, category);
CREATE INDEX IF NOT EXISTS idx_events_dedup ON session_events(session_id, data_hash);

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

CREATE TABLE IF NOT EXISTS session_meta (
  session_id TEXT UNIQUE NOT NULL,
  project_dir TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_event_at TEXT NOT NULL DEFAULT (datetime('now')),
  event_count INTEGER NOT NULL DEFAULT 0,
  compact_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS session_resume (
  id INTEGER PRIMARY KEY,
  session_id TEXT UNIQUE NOT NULL,
  snapshot TEXT NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  consumed INTEGER NOT NULL DEFAULT 0
);
`;

export const ALL_CATEGORIES: EventCategory[] = [
  "file", "git", "error", "task", "cwd", "mcp", "subagent", "prompt", "decision",
  "rule", "env", "skill", "intent",
];

/** SHA-256 first 16 hex chars — fast content-addressable dedup key */
function computeDataHash(data: string): string {
  return createHash("sha256").update(data).digest("hex").slice(0, 16);
}



export class EventStore {
  #db: Database;
  readonly #dbPath: string;
  #closed = false;

  constructor(dbPath: string) {
    this.#dbPath = dbPath;
    this.#db = new Database(dbPath);
  }

  init(): void {
    this.#db.exec("PRAGMA journal_mode = WAL;");
    this.#migrate();
    this.#db.exec(SCHEMA);
  }

  // ── Schema migration ────────────────────────────────────────

  #migrate(): void {
    const { user_version } = this.#db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (user_version >= SCHEMA_VERSION) return;

    // Upgrade from v0: session_events exists but lacks data_hash column
    const tableExists = this.#db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='session_events'",
    ).get();

    if (tableExists) {
      try {
        this.#db.exec("ALTER TABLE session_events ADD COLUMN data_hash TEXT NOT NULL DEFAULT ''");
      } catch {
        // Column already exists (fresh install ran SCHEMA first somehow)
      }
    }

    this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  }

  // ── Write with dedup + eviction ─────────────────────────────

  writeEvent(event: Omit<TrackedEvent, "id" | "dataHash">): void {
    const dataHash = computeDataHash(event.data);
    if (this.#isDuplicate(event.sessionId, event.category, dataHash)) return;

    this.#db.prepare(
      "INSERT INTO session_events (session_id, category, data, priority, source, timestamp, data_hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(event.sessionId, event.category, event.data, event.priority, event.source, event.timestamp, dataHash);

    this.#enforceEventCap(event.sessionId);
  }

  writeEvents(events: Omit<TrackedEvent, "id" | "dataHash">[]): void {
    if (events.length === 0) return;

    const insert = this.#db.prepare(
      "INSERT INTO session_events (session_id, category, data, priority, source, timestamp, data_hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const tx = this.#db.transaction(() => {
      for (const event of events) {
        const dataHash = computeDataHash(event.data);
        if (this.#isDuplicate(event.sessionId, event.category, dataHash)) continue;
        insert.run(event.sessionId, event.category, event.data, event.priority, event.source, event.timestamp, dataHash);
      }
    });
    tx();

    this.#enforceEventCap(events[0].sessionId);
  }

  /** Check last DEDUP_WINDOW events for same category + content hash */
  #isDuplicate(sessionId: string, category: string, dataHash: string): boolean {
    const row = this.#db.prepare(
      `SELECT 1 FROM (
        SELECT category, data_hash FROM session_events
        WHERE session_id = ? ORDER BY id DESC LIMIT ?
      ) WHERE category = ? AND data_hash = ? LIMIT 1`,
    ).get(sessionId, DEDUP_WINDOW, category, dataHash);
    return row != null;
  }

  /** Delete lowest-priority (highest number), then oldest events to stay at cap */
  #enforceEventCap(sessionId: string): void {
    const { count } = this.#db.prepare(
      "SELECT COUNT(*) AS count FROM session_events WHERE session_id = ?",
    ).get(sessionId) as { count: number };

    if (count <= MAX_EVENTS_PER_SESSION) return;

    const excess = count - MAX_EVENTS_PER_SESSION;
    this.#db.prepare(
      `DELETE FROM session_events WHERE id IN (
        SELECT id FROM session_events WHERE session_id = ?
        ORDER BY CAST(priority AS INTEGER) DESC, timestamp ASC
        LIMIT ?
      )`,
    ).run(sessionId, excess);
  }

  // ── Read ────────────────────────────────────────────────────

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
      conditions.push("CAST(priority AS INTEGER) = ?");
      params.push(filters.priority);
    }
    if (filters?.since) {
      conditions.push("timestamp > ?");
      params.push(filters.since);
    }

    let sql = `SELECT id, session_id AS sessionId, category, data, priority, source, timestamp, data_hash AS dataHash FROM session_events WHERE ${conditions.join(" AND ")} ORDER BY timestamp DESC`;

    if (filters?.limit) {
      sql += " LIMIT ?";
      params.push(filters.limit);
    }

    return this.#db.prepare(sql).all(...params) as TrackedEvent[];
  }

  searchEvents(sessionId: string, query: string, limit = 20): TrackedEvent[] {
    const sql = `
      SELECT e.id, e.session_id AS sessionId, e.category, e.data, e.priority,
             e.source, e.timestamp, e.data_hash AS dataHash
      FROM session_events_fts fts
      JOIN session_events e ON e.id = fts.rowid
      WHERE fts.data MATCH ? AND e.session_id = ?
      ORDER BY rank
      LIMIT ?
    `;
    return this.#db.prepare(sql).all(query, sessionId, limit) as TrackedEvent[];
  }

  getEventCounts(sessionId: string): Record<EventCategory, number> {
    const rows = this.#db.prepare(
      "SELECT category, COUNT(*) AS count FROM session_events WHERE session_id = ? GROUP BY category",
    ).all(sessionId) as Array<{ category: EventCategory; count: number }>;

    const counts = {} as Record<EventCategory, number>;
    for (const cat of ALL_CATEGORIES) counts[cat] = 0;
    for (const row of rows) counts[row.category] = row.count;
    return counts;
  }

  // ── Session metadata ────────────────────────────────────────

  upsertMeta(sessionId: string, projectDir: string): void {
    this.#db.prepare(
      `INSERT INTO session_meta (session_id, project_dir, event_count)
       VALUES (?, ?, 0)
       ON CONFLICT(session_id) DO UPDATE SET
         last_event_at = datetime('now'),
         event_count = event_count + 1`,
    ).run(sessionId, projectDir);
  }

  getMeta(sessionId: string): SessionMeta | null {
    const row = this.#db.prepare(
      `SELECT session_id AS sessionId, project_dir AS projectDir,
              started_at AS startedAt, last_event_at AS lastEventAt,
              event_count AS eventCount, compact_count AS compactCount
       FROM session_meta WHERE session_id = ?`,
    ).get(sessionId) as SessionMeta | undefined;
    return row ?? null;
  }

  incrementCompactCount(sessionId: string): void {
    this.#db.prepare(
      "UPDATE session_meta SET compact_count = compact_count + 1 WHERE session_id = ?",
    ).run(sessionId);
  }

  // ── Resume snapshots ────────────────────────────────────────

  upsertResume(sessionId: string, snapshot: string, eventCount: number): void {
    this.#db.prepare(
      `INSERT INTO session_resume (session_id, snapshot, event_count, consumed)
       VALUES (?, ?, ?, 0)
       ON CONFLICT(session_id) DO UPDATE SET
         snapshot = excluded.snapshot,
         event_count = excluded.event_count,
         created_at = datetime('now'),
         consumed = 0`,
    ).run(sessionId, snapshot, eventCount);
  }

  getResume(sessionId: string): SessionResume | null {
    const row = this.#db.prepare(
      `SELECT session_id AS sessionId, snapshot, event_count AS eventCount,
              created_at AS createdAt, consumed
       FROM session_resume WHERE session_id = ? AND consumed = 0`,
    ).get(sessionId) as (Omit<SessionResume, "consumed"> & { consumed: number }) | undefined;
    if (!row) return null;
    return { ...row, consumed: row.consumed !== 0 };
  }

  consumeResume(sessionId: string): void {
    this.#db.prepare(
      "UPDATE session_resume SET consumed = 1 WHERE session_id = ?",
    ).run(sessionId);
  }

  // ── Maintenance ─────────────────────────────────────────────

  pruneEvents(olderThan: number): number {
    const countRow = this.#db.prepare(
      "SELECT COUNT(*) AS count FROM session_events WHERE timestamp < ?",
    ).get(olderThan) as { count: number };
    if (countRow.count > 0) {
      this.#db.prepare("DELETE FROM session_events WHERE timestamp < ?").run(olderThan);
    }
    return countRow.count;
  }

  pruneOldSessions(retentionDays = 7): number {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const pruned = this.pruneEvents(cutoff);
    // Remove orphaned metadata for sessions with no remaining events
    this.#db.exec(`
      DELETE FROM session_meta WHERE session_id NOT IN (
        SELECT DISTINCT session_id FROM session_events
      );
      DELETE FROM session_resume WHERE session_id NOT IN (
        SELECT DISTINCT session_id FROM session_events
      );
    `);
    return pruned;
  }

  close(): void {
    if (this.#closed) return;

    try {
      // Mirror Bun's documented WAL cleanup path so Windows releases the main
      // database file instead of leaving teardown to fight lingering sidecar locks.
      this.#db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0);
      this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } finally {
      this.#db.close();
      this.#closed = true;
    }
  }
}
