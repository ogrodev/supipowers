// src/context-mode/metrics-store.ts
//
// Sidecar SQLite store for L1 measurement. Lives alongside `events.db` under
// `<projectStateDir>/sessions/metrics.db`. Mirrors the `event-store.ts`
// conventions (DELETE journal mode, WAL sidecar cleanup, idempotent migration)
// but keeps an independent failure mode so a metrics issue cannot regress
// event tracking.
//
// Hot-path contract (see design spec §3 + plan preamble):
//   - `record(row)` is sync-looking; it appends to an in-memory queue and
//     arms a `queueMicrotask` flush. Tests await `flushPendingForTest()`
//     before reading durable state.
//   - Bursts that arrive in the same microtask coalesce into one transaction.
//   - Failures are swallowed; the in-memory failure counter combined with the
//     persisted column lets `/supi:doctor` surface degraded sessions.

import { constants, Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { isDebugEnabled } from "../debug/logger.js";

export const SCHEMA_VERSION = 3;
export const MAX_ROWS_PER_SESSION = 5000;
export const RETENTION_DAYS = 7;

export type LayerKey = "L1" | "L2" | "L3" | "L4" | "L5" | "L6" | "L7";

export type ProcessorKey =
  | "bash"
  | "read"
  | "search"
  | "find"
  | "passthrough"
  | "omp-minimizer"
  | "git"
  | "test"
  | "lint"
  | "build"
  | "k8s"
  | "docker"
  | "log"
  | "json"
  | "dedup"
  | "lazy-tools"
  | "startup-optimizer"
  | "cache-store"
  | "cache-spill"
  | "cache-open"
  | "cache-prune"
  | "cache-clear"
  | null;

/** A single metric row pending insertion or read from the metrics table. */
export interface MetricRow {
  session_id: string;
  ts: number;
  layer: LayerKey;
  tool: string;
  processor: ProcessorKey;
  before_bytes: number;
  after_bytes: number;
  cache_hit: 0 | 1;
  unique_source_hash: string | null;
  context_tokens: number | null;
  context_window: number | null;
  context_percent: number | null;
}

export interface SessionMetaMetrics {
  session_id: string;
  cwd: string;
  started_at: number;
  last_event_at: number;
  row_count: number;
  write_failures: number;
  last_clear_at: number | null;
}

export interface ProjectMetaMetrics {
  project_slug: string;
  first_run_notice_shown_at: number | null;
  last_prune_at: number | null;
  last_clear_all_at: number | null;
}

export interface MetricsStoreOptions {
  dbPath: string;
  projectSlug: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  layer TEXT NOT NULL,
  tool TEXT NOT NULL,
  processor TEXT,
  before_bytes INTEGER NOT NULL,
  after_bytes INTEGER NOT NULL,
  cache_hit INTEGER NOT NULL DEFAULT 0,
  unique_source_hash TEXT,
  context_tokens INTEGER,
  context_window INTEGER,
  context_percent REAL
);

CREATE INDEX IF NOT EXISTS idx_metrics_session_ts ON metrics(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_metrics_layer_tool ON metrics(layer, tool);

CREATE TABLE IF NOT EXISTS session_meta_metrics (
  session_id TEXT PRIMARY KEY,
  cwd TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  last_event_at INTEGER NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  write_failures INTEGER NOT NULL DEFAULT 0,
  last_clear_at INTEGER
);

CREATE TABLE IF NOT EXISTS project_meta_metrics (
  project_slug TEXT PRIMARY KEY,
  first_run_notice_shown_at INTEGER,
  last_prune_at INTEGER,
  last_clear_all_at INTEGER
);
`;

function appendTraceLine(filePath: string, entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(
      filePath,
      JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n",
    );
  } catch {
    // Trace logging must never block the primary flow.
  }
}

export class MetricsStore {
  readonly #dbPath: string;
  readonly #projectSlug: string;
  #db: Database;
  #closed = false;

  // Microtask-batched write queue + a per-burst flush promise so tests can await it.
  #queue: MetricRow[] = [];
  #flushScheduled = false;
  #flushPromise: Promise<void> | null = null;
  #flushResolve: (() => void) | null = null;

  // Per-session in-memory write failures, combined with persisted column on read.
  #inMemoryFailures = new Map<string, number>();

  // Per-instance flush counter — used by tests to confirm batching works.
  #flushCount = 0;

  // Trace path is computed once on init; null when SUPI_DEBUG is unset.
  #tracePath: string | null = null;

  // Prepared statements (lazy, initialized on first use).
  #insertStmt: ReturnType<Database["prepare"]> | null = null;
  #upsertSessionStmt: ReturnType<Database["prepare"]> | null = null;
  #incRowCountStmt: ReturnType<Database["prepare"]> | null = null;
  #evictOldestStmt: ReturnType<Database["prepare"]> | null = null;
  #updateRowCountStmt: ReturnType<Database["prepare"]> | null = null;
  #flushTransaction: ((rows: MetricRow[]) => void) | null = null;

  constructor(opts: MetricsStoreOptions) {
    this.#dbPath = opts.dbPath;
    this.#projectSlug = opts.projectSlug;
    this.#db = new Database(opts.dbPath);
  }

  /** Absolute path to the on-disk SQLite file. */
  get dbPath(): string {
    return this.#dbPath;
  }

  /** Project slug supplied at construction (primary key into `project_meta_metrics`). */
  get projectSlug(): string {
    return this.#projectSlug;
  }

  /** Number of times the microtask flush function has run. Test-only. */
  get flushCountForTest(): number {
    return this.#flushCount;
  }

  /** Trace file path (null when `SUPI_DEBUG` is unset). Test-only. */
  get tracePathForTest(): string | null {
    return this.#tracePath;
  }

  init(): void {
    try {
      this.#ensureDeleteJournalMode();
      // CREATE TABLE IF NOT EXISTS guards every statement in SCHEMA, so it is
      // safe to run before #migrate(). Running the schema first means v1→vN
      // data fixups can assume their target tables exist on every code path.
      this.#db.exec(SCHEMA);
      this.#migrate();
      this.#prepareStatements();

      if (isDebugEnabled()) {
        this.#tracePath = path.join(path.dirname(this.#dbPath), "metrics-trace.jsonl");
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }

  // ── Journal mode + WAL handling (mirrors event-store.ts) ────────────

  #ensureDeleteJournalMode(): void {
    const journalMode = this.#getJournalMode();
    if (journalMode === "delete") return;

    if (journalMode === "wal") {
      this.#cleanupWalSidecars();
    }

    try {
      this.#db.exec("PRAGMA journal_mode = DELETE;");
    } catch {
      // Older WAL-backed databases can stay on WAL for this process.
      // close() still checkpoints them so teardown and the next reopen succeed.
    }
  }

  #getJournalMode(): string {
    const { journal_mode } = this.#db.prepare("PRAGMA journal_mode").get() as {
      journal_mode: string;
    };
    return journal_mode.toLowerCase();
  }

  #cleanupWalSidecars(): void {
    try {
      this.#db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0);
      this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {
      // Best effort only: close() still releases the handle in finally.
    }
  }

  // ── Schema migration ─────────────────────────────────────────────────

  #migrate(): void {
    const { user_version } = this.#db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };

    if (user_version === SCHEMA_VERSION) return;
    if (user_version > SCHEMA_VERSION) {
      throw new Error(
        `metrics-store: unknown schema version ${user_version} (max supported: ${SCHEMA_VERSION})`,
      );
    }

    // v0 \u2192 v1: schema-only bump. CREATE TABLE IF NOT EXISTS already ran in
    // init(); no data fixup is required.

    // v1 \u2192 v2: OMP 14.5.12 renamed the canonical "grep" tool key to "search".
    // Rows persisted under the old name still report `tool='grep'` and
    // `processor='grep'` \u2014 values the type system no longer admits and which
    // /supi:doctor / per-processor breakdowns would silently bucket under a
    // typed-impossible key. Source hashes baked the legacy `grep:` prefix into
    // SHA256, so they cannot collide with post-rename `search:`-prefixed
    // hashes; the privacy contract forbids reconstructing the original path
    // or pattern, so re-hashing is impossible. NULL is the right substitute:
    // `getUniqueSourceShare` already excludes NULL hashes from numerator and
    // denominator, and a NULL hash never collides with new dedup state.
    if (user_version < 2) {
      const tx = this.#db.transaction(() => {
        this.#db.exec(
          `UPDATE metrics SET unique_source_hash = NULL WHERE tool = 'grep'`,
        );
        this.#db.exec(
          `UPDATE metrics SET tool = 'search' WHERE tool = 'grep'`,
        );
        this.#db.exec(
          `UPDATE metrics SET processor = 'search' WHERE processor = 'grep'`,
        );
      });
      tx();
    }

    // v2 → v3: OMP 14.6.0 renamed `search`/`find` tool params from
    // `path: string` / `pattern: string` to `paths: string[]`. Source hashes
    // computed under the old salts (`search:<single-path>:<slug>`,
    // `find:<pattern>:<slug>`) cannot collide with the new salts
    // (`search:<joined-paths>:<pattern>:<slug>`, `find:<joined-paths>:<slug>`)
    // because the input strings differ; but the privacy contract forbids
    // re-hashing, so NULL is the correct substitute. `getUniqueSourceShare`
    // already excludes NULLs from numerator/denominator. Newly-recorded rows
    // from this point on use the post-rename salt.
    if (user_version < 3) {
      this.#db.exec(
        `UPDATE metrics SET unique_source_hash = NULL WHERE tool IN ('search', 'find')`,
      );
    }

    this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  }

  // ── Prepared statements ─────────────────────────────────────────────

  #prepareStatements(): void {
    this.#insertStmt = this.#db.prepare(
      `INSERT INTO metrics
         (session_id, ts, layer, tool, processor, before_bytes, after_bytes,
          cache_hit, unique_source_hash, context_tokens, context_window, context_percent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this.#upsertSessionStmt = this.#db.prepare(
      `INSERT INTO session_meta_metrics
         (session_id, cwd, started_at, last_event_at, row_count, write_failures, last_clear_at)
         VALUES (?, ?, ?, ?, 0, 0, NULL)
         ON CONFLICT(session_id) DO UPDATE SET
           last_event_at = excluded.last_event_at`,
    );

    this.#incRowCountStmt = this.#db.prepare(
      `UPDATE session_meta_metrics
         SET row_count = row_count + ?, last_event_at = ?
         WHERE session_id = ?`,
    );

    this.#updateRowCountStmt = this.#db.prepare(
      `UPDATE session_meta_metrics
         SET row_count = ?
         WHERE session_id = ?`,
    );

    this.#evictOldestStmt = this.#db.prepare(
      `DELETE FROM metrics
         WHERE id IN (
           SELECT id FROM metrics
             WHERE session_id = ?
             ORDER BY id ASC
             LIMIT ?
         )`,
    );

    this.#flushTransaction = this.#db.transaction((rows: MetricRow[]) => {
      const perSession = new Map<string, number>();
      const lastTsBySession = new Map<string, number>();

      for (const row of rows) {
        this.#insertStmt!.run(
          row.session_id,
          row.ts,
          row.layer,
          row.tool,
          row.processor,
          row.before_bytes,
          row.after_bytes,
          row.cache_hit,
          row.unique_source_hash,
          row.context_tokens,
          row.context_window,
          row.context_percent,
        );

        perSession.set(row.session_id, (perSession.get(row.session_id) ?? 0) + 1);
        const prev = lastTsBySession.get(row.session_id);
        if (prev === undefined || row.ts > prev) {
          lastTsBySession.set(row.session_id, row.ts);
        }
      }

      // Flush in-memory failures opportunistically: if persistence is healthy,
      // promote any pending in-memory counts into the column and clear the
      // in-memory entries so the doctor surfaces a stable number.
      const failures = [...this.#inMemoryFailures.entries()];
      for (const [session, count] of failures) {
        this.#db.prepare(
          `UPDATE session_meta_metrics
             SET write_failures = write_failures + ?
             WHERE session_id = ?`,
        ).run(count, session);
      }
      this.#inMemoryFailures.clear();

      // Bump row_count and last_event_at per session.
      for (const [session, count] of perSession) {
        const ts = lastTsBySession.get(session) ?? Date.now();
        this.#incRowCountStmt!.run(count, ts, session);
      }

      // Eviction: per-session row_count cap. Read fresh count from DB to
      // accommodate inserts that arrived in a separate transaction.
      for (const [session] of perSession) {
        const row = this.#db.prepare(
          `SELECT row_count FROM session_meta_metrics WHERE session_id = ?`,
        ).get(session) as { row_count: number } | undefined;
        if (!row) continue;
        const overflow = row.row_count - MAX_ROWS_PER_SESSION;
        if (overflow > 0) {
          this.#evictOldestStmt!.run(session, overflow);
          this.#updateRowCountStmt!.run(MAX_ROWS_PER_SESSION, session);
        }
      }
    });
  }

  // ── Session metadata ────────────────────────────────────────────────

  upsertSession(opts: { session_id: string; cwd: string; ts?: number }): void {
    const ts = opts.ts ?? Date.now();
    this.#upsertSessionStmt!.run(opts.session_id, opts.cwd, ts, ts);
  }

  getSessionMeta(sessionId: string): SessionMetaMetrics | null {
    const row = this.#db.prepare(
      `SELECT session_id, cwd, started_at, last_event_at, row_count, write_failures, last_clear_at
         FROM session_meta_metrics
         WHERE session_id = ?`,
    ).get(sessionId) as SessionMetaMetrics | undefined;
    return row ?? null;
  }

  getProjectMeta(projectSlug: string): ProjectMetaMetrics | null {
    const row = this.#db.prepare(
      `SELECT project_slug, first_run_notice_shown_at, last_prune_at, last_clear_all_at
         FROM project_meta_metrics
         WHERE project_slug = ?`,
    ).get(projectSlug) as ProjectMetaMetrics | undefined;
    return row ?? null;
  }

  setFirstRunNoticeShown(projectSlug: string, ts?: number): void {
    const value = ts ?? Date.now();
    this.#db.prepare(
      `INSERT INTO project_meta_metrics (project_slug, first_run_notice_shown_at)
         VALUES (?, ?)
         ON CONFLICT(project_slug) DO UPDATE SET
           first_run_notice_shown_at = excluded.first_run_notice_shown_at`,
    ).run(projectSlug, value);
  }

  // ── Hot-path write API ───────────────────────────────────────────────

  record(row: MetricRow): void {
    if (this.#closed) {
      this.#bumpInMemoryFailure(row.session_id);
      this.#trace("metrics_record_after_close", {
        session_id: row.session_id,
        tool: row.tool,
      });
      return;
    }

    this.#queue.push(row);
    if (!this.#flushScheduled) {
      this.#flushScheduled = true;
      this.#flushPromise = new Promise<void>((resolve) => {
        this.#flushResolve = resolve;
      });
      queueMicrotask(() => this.#flush());
    }
  }

  /** Drain the pending microtask flush. Tests await this before reading state. */
  async flushPendingForTest(): Promise<void> {
    while (this.#flushScheduled) {
      const promise = this.#flushPromise;
      if (promise) await promise;
      else break;
    }
  }

  #flush(): void {
    const rows = this.#queue;
    this.#queue = [];
    this.#flushScheduled = false;
    this.#flushCount += 1;

    const resolve = this.#flushResolve;
    this.#flushResolve = null;
    this.#flushPromise = null;

    if (rows.length === 0) {
      if (resolve) resolve();
      return;
    }

    let attempts = 0;
    while (true) {
      try {
        this.#flushTransaction!(rows);
        for (const row of rows) {
          this.#trace("metrics_record_flushed", {
            tool: row.tool,
            layer: row.layer,
            before_bytes: row.before_bytes,
            after_bytes: row.after_bytes,
          });
        }
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (attempts === 0 && code === "SQLITE_BUSY") {
          attempts += 1;
          // Linear backoff (sleep ~5ms) before the single retry.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
          continue;
        }

        for (const row of rows) {
          this.#bumpInMemoryFailure(row.session_id);
          this.#trace("metrics_record_failed", {
            tool: row.tool,
            error: (err as Error)?.message ?? String(err),
          });
        }
        break;
      }
    }

    if (resolve) resolve();
  }

  #bumpInMemoryFailure(sessionId: string): void {
    this.#inMemoryFailures.set(sessionId, (this.#inMemoryFailures.get(sessionId) ?? 0) + 1);
  }

  #trace(event: string, data: Record<string, unknown>): void {
    if (!this.#tracePath) return;
    appendTraceLine(this.#tracePath, { event, ...data });
  }

  // ── Read accessors ───────────────────────────────────────────────────

  getSessionTotals(sessionId: string): {
    beforeBytes: number;
    afterBytes: number;
    saved: number;
    rowCount: number;
  } {
    const row = this.#db.prepare(
      `SELECT
         COALESCE(SUM(before_bytes), 0) AS beforeBytes,
         COALESCE(SUM(after_bytes), 0) AS afterBytes,
         COALESCE(SUM(before_bytes - after_bytes), 0) AS saved,
         COUNT(*) AS rowCount
       FROM metrics
       WHERE session_id = ?`,
    ).get(sessionId) as {
      beforeBytes: number;
      afterBytes: number;
      saved: number;
      rowCount: number;
    };
    return row;
  }

  getTopProcessors(
    sessionId: string,
    limit: number,
  ): Array<{ processor: string; saved: number; calls: number }> {
    return this.#db.prepare(
      `SELECT
         COALESCE(processor, tool) AS processor,
         COALESCE(SUM(before_bytes - after_bytes), 0) AS saved,
         COUNT(*) AS calls
       FROM metrics
       WHERE session_id = ?
       GROUP BY COALESCE(processor, tool)
       ORDER BY saved DESC
       LIMIT ?`,
    ).all(sessionId, limit) as Array<{ processor: string; saved: number; calls: number }>;
  }

  getPerLayer(
    sessionId: string,
  ): Array<{ layer: string; saved: number; rows: number }> {
    return this.#db.prepare(
      `SELECT
         layer,
         COALESCE(SUM(before_bytes - after_bytes), 0) AS saved,
         COUNT(*) AS rows
       FROM metrics
       WHERE session_id = ?
       GROUP BY layer
       ORDER BY layer ASC`,
    ).all(sessionId) as Array<{ layer: string; saved: number; rows: number }>;
  }

  /**
   * Unique-source share = COUNT(DISTINCT unique_source_hash) /
   *                       COUNT(unique_source_hash).
   * Null hashes are excluded from both numerator and denominator so that
   * untracked sources do not skew the rot signal. Returns 0 when no rows
   * have a non-null hash.
   */
  getUniqueSourceShare(sessionId: string): number {
    const row = this.#db.prepare(
      `SELECT
         COUNT(DISTINCT unique_source_hash) AS distinctCount,
         COUNT(unique_source_hash) AS totalCount
       FROM metrics
       WHERE session_id = ?`,
    ).get(sessionId) as { distinctCount: number; totalCount: number };

    if (row.totalCount === 0) return 0;
    return row.distinctCount / row.totalCount;
  }

  /** Combined in-memory + persisted write-failure count for the session. */
  getSessionWriteFailures(sessionId: string): number {
    const inMemory = this.#inMemoryFailures.get(sessionId) ?? 0;
    let persisted = 0;
    try {
      persisted = this.getSessionMeta(sessionId)?.write_failures ?? 0;
    } catch {
      // DB may be closed; in-memory counter still surfaces the failure.
    }
    return persisted + inMemory;
  }

  // ── Maintenance ─────────────────────────────────────────────────────

  pruneOldSessions(retentionDays = RETENTION_DAYS, now = Date.now()): number {
    const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;

    const oldSessions = this.#db.prepare(
      `SELECT session_id FROM session_meta_metrics WHERE started_at < ?`,
    ).all(cutoff) as Array<{ session_id: string }>;

    if (oldSessions.length > 0) {
      const placeholders = oldSessions.map(() => "?").join(",");
      const ids = oldSessions.map((r) => r.session_id);
      this.#db.prepare(
        `DELETE FROM metrics WHERE session_id IN (${placeholders})`,
      ).run(...ids);
      this.#db.prepare(
        `DELETE FROM session_meta_metrics WHERE session_id IN (${placeholders})`,
      ).run(...ids);
    }

    this.#db.prepare(
      `INSERT INTO project_meta_metrics (project_slug, last_prune_at)
         VALUES (?, ?)
         ON CONFLICT(project_slug) DO UPDATE SET
           last_prune_at = excluded.last_prune_at`,
    ).run(this.#projectSlug, now);

    return oldSessions.length;
  }

  // \u2500\u2500 Clearing (used by /supi:clear) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

  /** Delete metrics rows for a single session, reset row_count, stamp last_clear_at. */
  clearSession(sessionId: string, now = Date.now()): void {
    const tx = this.#db.transaction(() => {
      this.#db.prepare(`DELETE FROM metrics WHERE session_id = ?`).run(sessionId);
      this.#db.prepare(
        `UPDATE session_meta_metrics
         SET row_count = 0, last_clear_at = ?
         WHERE session_id = ?`,
      ).run(now, sessionId);
    });
    tx();
    this.#inMemoryFailures.delete(sessionId);
  }

  /** Returns one row per session in this project, ordered by started_at desc. */
  listSessions(
    _projectSlug: string,
  ): Array<{ session_id: string; row_count: number; started_at: number; cwd: string }> {
    return this.#db
      .prepare(
        `SELECT session_id, row_count, started_at, cwd
         FROM session_meta_metrics
         ORDER BY started_at DESC`,
      )
      .all() as Array<{
        session_id: string;
        row_count: number;
        started_at: number;
        cwd: string;
      }>;
  }

  /** Delete all metrics rows in the project, reset every session's row_count,
   *  preserve session metadata (`started_at`, `cwd`), and stamp
   *  `project_meta_metrics.last_clear_all_at`.
   *
   *  The `projectSlug` parameter is accepted for API symmetry with the rest of
   *  the project-meta accessors, but the store always operates on its bound
   *  slug. Callers do not need to pass anything special: the store's own
   *  projectSlug is the source of truth.
   */
  clearProject(_projectSlug?: string, now = Date.now()): void {
    const slug = this.#projectSlug;
    const tx = this.#db.transaction(() => {
      this.#db.exec(`DELETE FROM metrics`);
      this.#db.exec(`UPDATE session_meta_metrics SET row_count = 0`);
      this.#db.prepare(
        `INSERT INTO project_meta_metrics (project_slug, last_clear_all_at)
         VALUES (?, ?)
         ON CONFLICT(project_slug) DO UPDATE SET
           last_clear_all_at = excluded.last_clear_all_at`,
      ).run(slug, now);
    });
    tx();
    this.#inMemoryFailures.clear();
  }

  close(): void {
    if (this.#closed) return;

    // Drain any queued writes synchronously before closing the DB. `record()`
    // schedules flushes via `queueMicrotask`, so a `record()` followed by an
    // immediate `close()` (e.g. session_shutdown after the last tool_result)
    // would otherwise lose pending rows when the microtask later runs against
    // a closed handle. `#flush()` already swallows write errors and bumps the
    // in-memory failure counter, so this drain cannot throw.
    if (this.#queue.length > 0) {
      this.#flush();
    }

    this.#closed = true;

    try {
      try {
        if (this.#getJournalMode() === "wal") {
          this.#cleanupWalSidecars();
        }
      } catch {
        // The DB path may already be gone during teardown.
      }
    } finally {
      this.#db.close();
    }
  }
}

// ── Module-level singleton + test seam ─────────────────────────────────

let _metricsStoreRef: MetricsStore | null = null;

/** Return the active metrics store, or `null` when context-mode is disabled. */
export function getMetricsStore(): MetricsStore | null {
  return _metricsStoreRef;
}

/**
 * Test-only setter. Production code wires the ref through the same path from
 * inside `registerContextModeHooks`. The double-underscore prefix marks this
 * as a private API; do **not** call it from product code.
 */
export function __setMetricsStoreForTest(store: MetricsStore | null): void {
  _metricsStoreRef = store;
}

/** Reset module-level state. Intended for `_resetCache()` in tests. */
export function _resetMetricsStoreCache(): void {
  _metricsStoreRef = null;
}
