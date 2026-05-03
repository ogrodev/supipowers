// tests/context-mode/metrics-store.test.ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import {
  MAX_ROWS_PER_SESSION,
  MetricsStore,
  SCHEMA_VERSION,
  __setMetricsStoreForTest,
  _resetMetricsStoreCache,
  getMetricsStore,
  type MetricRow,
} from "../../src/context-mode/metrics-store.js";
import { rmDirWithRetry } from "../helpers/fs.js";

let tmpDir: string;
let dbPath: string;
let store: MetricsStore;

function row(overrides: Partial<MetricRow> = {}): MetricRow {
  return {
    session_id: "s1",
    ts: Date.now(),
    layer: "L2",
    tool: "bash",
    processor: "bash",
    before_bytes: 1000,
    after_bytes: 100,
    cache_hit: 0,
    unique_source_hash: null,
    context_tokens: null,
    context_window: null,
    context_percent: null,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-metrics-"));
  dbPath = path.join(tmpDir, "metrics.db");
  store = new MetricsStore({ dbPath, projectSlug: "demo" });
  store.init();
});

afterEach(() => {
  try {
    store.close();
  } catch {
    // already closed
  }
  if (fs.existsSync(tmpDir)) {
    rmDirWithRetry(tmpDir);
  }
  delete process.env.SUPI_DEBUG;
});

describe("MetricsStore.init", () => {
  test("creates schema at SCHEMA_VERSION on a fresh DB", () => {
    const probe = new Database(dbPath);
    try {
      const found = probe
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('metrics','session_meta_metrics','project_meta_metrics')`,
        )
        .all() as Array<{ name: string }>;
      const names = new Set(found.map((r) => r.name));
      expect(names.has("metrics")).toBe(true);
      expect(names.has("session_meta_metrics")).toBe(true);
      expect(names.has("project_meta_metrics")).toBe(true);

      const { user_version } = probe.prepare(`PRAGMA user_version`).get() as {
        user_version: number;
      };
      expect(user_version).toBe(SCHEMA_VERSION);

    } finally {
      probe.close();
    }
  });

  test("reopening an existing DB at SCHEMA_VERSION is idempotent", () => {
    store.close();
    const reopened = new MetricsStore({ dbPath, projectSlug: "demo" });
    reopened.init();

    const probe = new Database(dbPath, { readonly: true });
    try {
      const { user_version } = probe.prepare(`PRAGMA user_version`).get() as {
        user_version: number;
      };
      expect(user_version).toBe(SCHEMA_VERSION);
    } finally {
      probe.close();
      reopened.close();
    }

    // Re-open the original handle so afterEach's close() does not throw.
    store = new MetricsStore({ dbPath, projectSlug: "demo" });
    store.init();
  });

  test("refuses to open an unknown user_version", () => {
    store.close();

    const probe = new Database(dbPath);
    try {
      probe.exec(`PRAGMA user_version = 999;`);
    } finally {
      probe.close();
    }

    const corrupted = new MetricsStore({ dbPath, projectSlug: "demo" });
    expect(() => corrupted.init()).toThrow(/unknown schema version/);
    corrupted.close();

    // Restore a clean store for afterEach.
    fs.unlinkSync(dbPath);
    store = new MetricsStore({ dbPath, projectSlug: "demo" });
    store.init();
  });

  test("WAL sidecars are cleaned up", () => {
    store.close();

    // Put the DB into WAL mode and write something so real -wal/-shm files exist.
    const wal = new Database(dbPath);
    try {
      wal.exec(`PRAGMA journal_mode = WAL;`);
      wal.exec(`CREATE TABLE IF NOT EXISTS sentinel (id INTEGER PRIMARY KEY);`);
      wal.exec(`INSERT INTO sentinel (id) VALUES (1);`);
    } finally {
      wal.close();
    }

    const reopened = new MetricsStore({ dbPath, projectSlug: "demo" });
    reopened.init();

    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);

    reopened.close();

    store = new MetricsStore({ dbPath, projectSlug: "demo" });
    store.init();
  });

  test("metrics-store init does not modify a sibling events.db (Task 54)", () => {
    // Pre-populate a sibling events.db file with arbitrary bytes; metrics
    // init must never touch it.
    const eventsPath = path.join(tmpDir, "events.db");
    fs.writeFileSync(eventsPath, "fake-events-payload");
    const before = fs.readFileSync(eventsPath);

    const reopened = new MetricsStore({ dbPath, projectSlug: "demo" });
    reopened.init();
    reopened.close();

    const after = fs.readFileSync(eventsPath);
    expect(after.equals(before)).toBe(true);
  });
});

describe("MetricsStore.init v1 \u2192 v2 migration", () => {
  /**
   * Helper: take a fresh metrics.db at the latest schema and dial it back to
   * a v1-shaped store, inserting the grep-era rows we expect to see in the
   * wild after upgrading from OMP 14.5.11 or earlier.
   */
  function seedV1WithGrepRows(): void {
    store.close();
    const probe = new Database(dbPath);
    try {
      probe.exec("PRAGMA user_version = 1;");
      const insert = probe.prepare(
        `INSERT INTO metrics
           (session_id, ts, layer, tool, processor, before_bytes, after_bytes,
            cache_hit, unique_source_hash, context_tokens, context_window, context_percent)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      // Two grep rows (one with a hash, one with a passthrough/null processor)
      // plus an unrelated read row that must survive the migration unchanged.
      insert.run("s1", 1, "L2", "grep", "grep", 1000, 100, 0, "legacy-grep-hash", null, null, null);
      insert.run("s1", 2, "L2", "grep", "passthrough", 50, 50, 0, "legacy-grep-hash-2", null, null, null);
      insert.run("s1", 3, "L2", "read", "read", 2000, 200, 0, "read-hash", null, null, null);
    } finally {
      probe.close();
    }
  }

  test("rewrites tool='grep' to 'search', NULLs legacy hashes, bumps user_version", () => {
    seedV1WithGrepRows();

    const reopened = new MetricsStore({ dbPath, projectSlug: "demo" });
    reopened.init();
    reopened.close();

    const probe = new Database(dbPath, { readonly: true });
    try {
      const rows = probe
        .prepare(
          `SELECT tool, processor, unique_source_hash FROM metrics ORDER BY ts ASC`,
        )
        .all() as Array<{ tool: string; processor: string | null; unique_source_hash: string | null }>;
      expect(rows).toEqual([
        { tool: "search", processor: "search", unique_source_hash: null },
        { tool: "search", processor: "passthrough", unique_source_hash: null },
        { tool: "read", processor: "read", unique_source_hash: "read-hash" },
      ]);
      const { user_version } = probe.prepare(`PRAGMA user_version`).get() as {
        user_version: number;
      };
      expect(user_version).toBe(SCHEMA_VERSION);
    } finally {
      probe.close();
    }

    // Re-open the original handle so afterEach's close() does not throw.
    store = new MetricsStore({ dbPath, projectSlug: "demo" });
    store.init();
  });

  test("rewrites processor='grep' even when tool was already 'search'", () => {
    // Defensive case: a v1 row may have processor='grep' but tool='search'
    // if a future hot-fix scrubbed the tool column without scrubbing the
    // processor column. The migration must still rewrite the processor.
    store.close();
    const probe = new Database(dbPath);
    try {
      probe.exec("PRAGMA user_version = 1;");
      probe.prepare(
        `INSERT INTO metrics
           (session_id, ts, layer, tool, processor, before_bytes, after_bytes,
            cache_hit, unique_source_hash, context_tokens, context_window, context_percent)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("s1", 1, "L2", "search", "grep", 100, 50, 0, "hash-x", null, null, null);
    } finally {
      probe.close();
    }

    const reopened = new MetricsStore({ dbPath, projectSlug: "demo" });
    reopened.init();
    reopened.close();

    const probe2 = new Database(dbPath, { readonly: true });
    try {
      const row = probe2
        .prepare(`SELECT tool, processor, unique_source_hash FROM metrics`)
        .get() as { tool: string; processor: string; unique_source_hash: string | null };
      // tool stays 'search' (was already 'search'); processor rewrites to
      // 'search'; the hash that survived v1→v2 is NULL'd by the v2→v3
      // migration because tool='search' falls in the post-rename scope and
      // the privacy contract forbids re-hashing.
      expect(row).toEqual({ tool: "search", processor: "search", unique_source_hash: null });
    } finally {
      probe2.close();
    }

    store = new MetricsStore({ dbPath, projectSlug: "demo" });
    store.init();
  });

  test("v1 DB with no grep rows still bumps to SCHEMA_VERSION", () => {
    store.close();
    const probe = new Database(dbPath);
    try {
      probe.exec("PRAGMA user_version = 1;");
      probe.prepare(
        `INSERT INTO metrics
           (session_id, ts, layer, tool, processor, before_bytes, after_bytes,
            cache_hit, unique_source_hash, context_tokens, context_window, context_percent)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("s1", 1, "L2", "read", "read", 2000, 200, 0, "read-hash", null, null, null);
    } finally {
      probe.close();
    }

    const reopened = new MetricsStore({ dbPath, projectSlug: "demo" });
    reopened.init();
    reopened.close();

    const probe2 = new Database(dbPath, { readonly: true });
    try {
      const row = probe2
        .prepare(`SELECT tool, processor, unique_source_hash FROM metrics`)
        .get() as { tool: string; processor: string; unique_source_hash: string };
      expect(row).toEqual({ tool: "read", processor: "read", unique_source_hash: "read-hash" });
      const { user_version } = probe2.prepare(`PRAGMA user_version`).get() as {
        user_version: number;
      };
      expect(user_version).toBe(SCHEMA_VERSION);
    } finally {
      probe2.close();
    }

    store = new MetricsStore({ dbPath, projectSlug: "demo" });
    store.init();
  });
});

describe("MetricsStore.init v2 → v3 migration", () => {
  /**
   * Helper: dial the store back to a v2-shaped DB and seed rows that exercise
   * every branch of the v2→v3 migration:
   *   - search/find rows must have their unique_source_hash NULL'd because
   *     the OMP 14.6.0 path/pattern → paths[] rename changes the salt,
   *     and the privacy contract forbids re-hashing.
   *   - read/bash rows must survive untouched (their salts are unchanged).
   */
  function seedV2WithSearchFindRows(): void {
    store.close();
    const probe = new Database(dbPath);
    try {
      probe.exec("PRAGMA user_version = 2;");
      const insert = probe.prepare(
        `INSERT INTO metrics
           (session_id, ts, layer, tool, processor, before_bytes, after_bytes,
            cache_hit, unique_source_hash, context_tokens, context_window, context_percent)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insert.run("s1", 1, "L2", "search", "search", 1000, 100, 0, "legacy-search-hash", null, null, null);
      insert.run("s1", 2, "L2", "find", "find", 500, 50, 0, "legacy-find-hash", null, null, null);
      insert.run("s1", 3, "L2", "read", "read", 2000, 200, 0, "read-hash", null, null, null);
      insert.run("s1", 4, "L2", "bash", "bash", 800, 80, 0, "bash-hash", null, null, null);
    } finally {
      probe.close();
    }
  }

  test("NULLs unique_source_hash for tool IN ('search','find'), preserves others, bumps user_version", () => {
    seedV2WithSearchFindRows();

    const reopened = new MetricsStore({ dbPath, projectSlug: "demo" });
    reopened.init();
    reopened.close();

    const probe = new Database(dbPath, { readonly: true });
    try {
      const rows = probe
        .prepare(
          `SELECT tool, processor, unique_source_hash FROM metrics ORDER BY ts ASC`,
        )
        .all() as Array<{ tool: string; processor: string | null; unique_source_hash: string | null }>;
      expect(rows).toEqual([
        { tool: "search", processor: "search", unique_source_hash: null },
        { tool: "find", processor: "find", unique_source_hash: null },
        { tool: "read", processor: "read", unique_source_hash: "read-hash" },
        { tool: "bash", processor: "bash", unique_source_hash: "bash-hash" },
      ]);
      const { user_version } = probe.prepare(`PRAGMA user_version`).get() as {
        user_version: number;
      };
      expect(user_version).toBe(SCHEMA_VERSION);
    } finally {
      probe.close();
    }

    store = new MetricsStore({ dbPath, projectSlug: "demo" });
    store.init();
  });

  test("v2 DB with no search/find rows still bumps to SCHEMA_VERSION", () => {
    store.close();
    const probe = new Database(dbPath);
    try {
      probe.exec("PRAGMA user_version = 2;");
      probe.prepare(
        `INSERT INTO metrics
           (session_id, ts, layer, tool, processor, before_bytes, after_bytes,
            cache_hit, unique_source_hash, context_tokens, context_window, context_percent)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("s1", 1, "L2", "read", "read", 2000, 200, 0, "read-hash", null, null, null);
    } finally {
      probe.close();
    }

    const reopened = new MetricsStore({ dbPath, projectSlug: "demo" });
    reopened.init();
    reopened.close();

    const probe2 = new Database(dbPath, { readonly: true });
    try {
      const row = probe2
        .prepare(`SELECT tool, processor, unique_source_hash FROM metrics`)
        .get() as { tool: string; processor: string; unique_source_hash: string };
      expect(row).toEqual({ tool: "read", processor: "read", unique_source_hash: "read-hash" });
      const { user_version } = probe2.prepare(`PRAGMA user_version`).get() as {
        user_version: number;
      };
      expect(user_version).toBe(SCHEMA_VERSION);
    } finally {
      probe2.close();
    }

    store = new MetricsStore({ dbPath, projectSlug: "demo" });
    store.init();
  });
});

describe("MetricsStore.record", () => {
  test("inserts one row and increments row_count", async () => {
    store.upsertSession({ session_id: "s1", cwd: "/tmp/x" });
    store.record(row({ session_id: "s1" }));
    await store.flushPendingForTest();

    const probe = new Database(dbPath, { readonly: true });
    try {
      const { count } = probe
        .prepare(`SELECT COUNT(*) as count FROM metrics`)
        .get() as { count: number };
      const meta = probe
        .prepare(`SELECT row_count FROM session_meta_metrics WHERE session_id = 's1'`)
        .get() as { row_count: number };
      expect(count).toBe(1);
      expect(meta.row_count).toBe(1);
    } finally {
      probe.close();
    }
  });

  test("persists L2 processor family and dedup processor keys", async () => {
    store.upsertSession({ session_id: "s1", cwd: "/tmp/x" });
    store.record(row({ session_id: "s1", processor: "git" }));
    store.record(row({ session_id: "s1", processor: "dedup" }));
    await store.flushPendingForTest();

    const probe = new Database(dbPath, { readonly: true });
    try {
      const processors = probe
        .prepare(`SELECT processor FROM metrics WHERE session_id = 's1' ORDER BY id ASC`)
        .all() as Array<{ processor: string }>;
      expect(processors.map((entry) => entry.processor)).toEqual(["git", "dedup"]);
    } finally {
      probe.close();
    }
  });

  test("microtask burst coalesces into one transaction", async () => {
    store.upsertSession({ session_id: "s1", cwd: "/tmp/x" });
    expect(store.flushCountForTest).toBe(0);

    store.record(row({ session_id: "s1", before_bytes: 100, after_bytes: 10 }));
    store.record(row({ session_id: "s1", before_bytes: 200, after_bytes: 20 }));
    store.record(row({ session_id: "s1", before_bytes: 300, after_bytes: 30 }));
    await store.flushPendingForTest();

    expect(store.flushCountForTest).toBe(1);

    const probe = new Database(dbPath, { readonly: true });
    try {
      const { count } = probe
        .prepare(`SELECT COUNT(*) as count FROM metrics WHERE session_id = 's1'`)
        .get() as { count: number };
      expect(count).toBe(3);
    } finally {
      probe.close();
    }
  });

  test("failure increments write_failures and never throws", async () => {
    store.upsertSession({ session_id: "s1", cwd: "/tmp/x" });
    store.record(row({ session_id: "s1" }));
    await store.flushPendingForTest();

    store.close();

    expect(() => store.record(row({ session_id: "s1" }))).not.toThrow();
    await store.flushPendingForTest();

    expect(store.getSessionWriteFailures("s1")).toBeGreaterThanOrEqual(1);
  });

  test("close() drains pending writes before closing the DB", () => {
    // Regression: a record() followed by an immediate close() (e.g. session_shutdown
    // running on the same turn as the last tool_result) used to lose the queued row,
    // because the microtask flush would fire after the SQLite handle was closed.
    store.upsertSession({ session_id: "s1", cwd: "/tmp/x" });
    store.record(row({ session_id: "s1", before_bytes: 1234, after_bytes: 56 }));
    // No flushPendingForTest here \u2014 close() must drain synchronously.
    store.close();

    const probe = new Database(dbPath, { readonly: true });
    try {
      const persisted = probe
        .prepare(`SELECT before_bytes, after_bytes FROM metrics WHERE session_id = 's1'`)
        .all() as Array<{ before_bytes: number; after_bytes: number }>;
      expect(persisted).toHaveLength(1);
      expect(persisted[0].before_bytes).toBe(1234);
      expect(persisted[0].after_bytes).toBe(56);
    } finally {
      probe.close();
    }
  });

  test("per-session row cap evicts oldest", async () => {
    store.upsertSession({ session_id: "s1", cwd: "/tmp/x" });

    const baseTs = 1_700_000_000_000;
    for (let i = 0; i < MAX_ROWS_PER_SESSION + 1; i += 1) {
      store.record(row({ session_id: "s1", ts: baseTs + i, before_bytes: 50 + i }));
    }
    await store.flushPendingForTest();

    const probe = new Database(dbPath, { readonly: true });
    try {
      const { count } = probe
        .prepare(`SELECT COUNT(*) as count FROM metrics WHERE session_id = 's1'`)
        .get() as { count: number };
      expect(count).toBe(MAX_ROWS_PER_SESSION);

      const { firstBefore } = probe
        .prepare(
          `SELECT before_bytes as firstBefore FROM metrics WHERE session_id = 's1' ORDER BY id ASC LIMIT 1`,
        )
        .get() as { firstBefore: number };
      // The originally-first row had before_bytes=50; after eviction the
      // earliest surviving row had before_bytes=51 (i=1).
      expect(firstBefore).toBe(51);

      const meta = probe
        .prepare(`SELECT row_count FROM session_meta_metrics WHERE session_id = 's1'`)
        .get() as { row_count: number };
      expect(meta.row_count).toBe(MAX_ROWS_PER_SESSION);
    } finally {
      probe.close();
    }
  });

  test("hot-path budget for 1000 records (Task 11)", async () => {
    if (process.env.SUPI_SKIP_PERF) return;

    store.upsertSession({ session_id: "s1", cwd: "/tmp/x" });

    const start = performance.now();
    for (let i = 0; i < 1000; i += 1) {
      store.record(row({ session_id: "s1", ts: Date.now() + i }));
    }
    await store.flushPendingForTest();
    const elapsed = performance.now() - start;

    // Loose ceiling: a single transaction with 1000 prepared inserts on
    // bun:sqlite easily fits in well under 1s. The 1500ms ceiling tolerates
    // slow CI without losing the regression signal if we accidentally drop
    // microtask batching or prepared statements.
    expect(elapsed).toBeLessThan(1500);
  });
});

describe("MetricsStore.pruneOldSessions", () => {
  test("deletes data older than retention and updates last_prune_at", async () => {
    const ONE_DAY = 24 * 60 * 60 * 1000;
    const now = 1_700_000_000_000;
    const oldStart = now - 8 * ONE_DAY;

    store.upsertSession({ session_id: "old", cwd: "/tmp/old", ts: oldStart });
    store.record(row({ session_id: "old", ts: oldStart }));
    store.upsertSession({ session_id: "fresh", cwd: "/tmp/fresh", ts: now });
    store.record(row({ session_id: "fresh", ts: now }));
    await store.flushPendingForTest();

    const pruned = store.pruneOldSessions(7, now);
    expect(pruned).toBe(1);

    const probe = new Database(dbPath, { readonly: true });
    try {
      const oldCount = probe
        .prepare(`SELECT COUNT(*) as count FROM metrics WHERE session_id = 'old'`)
        .get() as { count: number };
      expect(oldCount.count).toBe(0);
      const oldMeta = probe
        .prepare(`SELECT COUNT(*) as count FROM session_meta_metrics WHERE session_id = 'old'`)
        .get() as { count: number };
      expect(oldMeta.count).toBe(0);

      const freshCount = probe
        .prepare(`SELECT COUNT(*) as count FROM metrics WHERE session_id = 'fresh'`)
        .get() as { count: number };
      expect(freshCount.count).toBe(1);

      const project = probe
        .prepare(`SELECT last_prune_at FROM project_meta_metrics WHERE project_slug = 'demo'`)
        .get() as { last_prune_at: number };
      expect(project.last_prune_at).toBe(now);
    } finally {
      probe.close();
    }
  });
});

describe("MetricsStore read accessors", () => {
  test("getSessionTotals returns sum / saved / rowCount", async () => {
    store.upsertSession({ session_id: "s1", cwd: "/tmp/x" });
    store.record(row({ session_id: "s1", before_bytes: 1000, after_bytes: 100 }));
    store.record(row({ session_id: "s1", before_bytes: 500, after_bytes: 50 }));
    await store.flushPendingForTest();

    const totals = store.getSessionTotals("s1");
    expect(totals.beforeBytes).toBe(1500);
    expect(totals.afterBytes).toBe(150);
    expect(totals.saved).toBe(1350);
    expect(totals.rowCount).toBe(2);
  });

  test("getTopProcessors groups by processor and falls back to tool for legacy rows", async () => {
    store.upsertSession({ session_id: "s1", cwd: "/tmp/x" });
    store.record(row({ session_id: "s1", tool: "bash", processor: "git", before_bytes: 1000, after_bytes: 100 }));
    store.record(row({ session_id: "s1", tool: "bash", processor: "git", before_bytes: 500, after_bytes: 100 }));
    store.record(row({ session_id: "s1", tool: "bash", processor: "test", before_bytes: 200, after_bytes: 100 }));
    store.record(row({ session_id: "s1", tool: "read", processor: null, before_bytes: 180, after_bytes: 100 }));
    await store.flushPendingForTest();

    const top = store.getTopProcessors("s1", 5);
    expect(top).toEqual([
      { processor: "git", saved: 1300, calls: 2 },
      { processor: "test", saved: 100, calls: 1 },
      { processor: "read", saved: 80, calls: 1 },
    ]);
  });

  test("getPerLayer groups by layer", async () => {
    store.upsertSession({ session_id: "s1", cwd: "/tmp/x" });
    store.record(row({ session_id: "s1", layer: "L2", before_bytes: 1000, after_bytes: 100 }));
    store.record(row({ session_id: "s1", layer: "L3", before_bytes: 200, after_bytes: 50 }));
    await store.flushPendingForTest();

    const layers = store.getPerLayer("s1");
    expect(layers).toEqual([
      { layer: "L2", saved: 900, rows: 1 },
      { layer: "L3", saved: 150, rows: 1 },
    ]);
  });

  test("getUniqueSourceShare excludes null hashes from numerator and denominator", async () => {
    store.upsertSession({ session_id: "s1", cwd: "/tmp/x" });
    store.record(row({ session_id: "s1", unique_source_hash: "a" }));
    store.record(row({ session_id: "s1", unique_source_hash: "a" }));
    store.record(row({ session_id: "s1", unique_source_hash: "b" }));
    store.record(row({ session_id: "s1", unique_source_hash: null }));
    await store.flushPendingForTest();

    // 2 distinct hashes / 3 non-null hashes ≈ 0.6667
    expect(store.getUniqueSourceShare("s1")).toBeCloseTo(2 / 3, 4);
  });

  test("getUniqueSourceShare returns 0 when every hash is null", async () => {
    store.upsertSession({ session_id: "s1", cwd: "/tmp/x" });
    store.record(row({ session_id: "s1", unique_source_hash: null }));
    store.record(row({ session_id: "s1", unique_source_hash: null }));
    await store.flushPendingForTest();

    expect(store.getUniqueSourceShare("s1")).toBe(0);
  });

  test("getSessionMeta returns full metadata", () => {
    const ts = 1_700_000_000_000;
    store.upsertSession({ session_id: "s1", cwd: "/tmp/x", ts });

    const meta = store.getSessionMeta("s1");
    expect(meta).not.toBeNull();
    expect(meta!.session_id).toBe("s1");
    expect(meta!.cwd).toBe("/tmp/x");
    expect(meta!.started_at).toBe(ts);
    expect(meta!.row_count).toBe(0);
    expect(meta!.write_failures).toBe(0);
    expect(meta!.last_clear_at).toBeNull();
  });

  test("getProjectMeta returns null when nothing has touched the project row yet", () => {
    expect(store.getProjectMeta("demo")).toBeNull();
  });

  test("setFirstRunNoticeShown writes the marker and getProjectMeta reads it", () => {
    const ts = 1_700_000_000_000;
    store.setFirstRunNoticeShown("demo", ts);
    const meta = store.getProjectMeta("demo");
    expect(meta).not.toBeNull();
    expect(meta!.first_run_notice_shown_at).toBe(ts);
  });
});

describe("MetricsStore singleton + test seam", () => {
  afterEach(() => {
    _resetMetricsStoreCache();
  });

  test("__setMetricsStoreForTest wires getMetricsStore()", () => {
    expect(getMetricsStore()).toBeNull();
    __setMetricsStoreForTest(store);
    expect(getMetricsStore()).toBe(store);
  });

  test("_resetMetricsStoreCache clears the ref", () => {
    __setMetricsStoreForTest(store);
    expect(getMetricsStore()).toBe(store);
    _resetMetricsStoreCache();
    expect(getMetricsStore()).toBeNull();
  });
});

describe("MetricsStore SUPI_DEBUG trace", () => {
  test("emits one JSONL trace line per flushed insert when SUPI_DEBUG=1", async () => {
    process.env.SUPI_DEBUG = "1";
    const debugDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-metrics-debug-"));
    const debugDb = path.join(debugDir, "metrics.db");
    const debugStore = new MetricsStore({ dbPath: debugDb, projectSlug: "trace-demo" });
    debugStore.init();

    debugStore.upsertSession({ session_id: "s1", cwd: "/tmp/x" });
    debugStore.record(row({ session_id: "s1", tool: "bash", before_bytes: 100, after_bytes: 10 }));
    debugStore.record(row({ session_id: "s1", tool: "read", before_bytes: 200, after_bytes: 20 }));
    debugStore.record(row({ session_id: "s1", tool: "search", before_bytes: 300, after_bytes: 30 }));
    await debugStore.flushPendingForTest();

    const tracePath = debugStore.tracePathForTest;
    expect(tracePath).not.toBeNull();
    expect(fs.existsSync(tracePath!)).toBe(true);
    const lines = fs.readFileSync(tracePath!, "utf-8").trim().split("\n");
    const flushed = lines
      .map((l) => JSON.parse(l))
      .filter((entry: any) => entry.event === "metrics_record_flushed");
    expect(flushed).toHaveLength(3);
    for (const entry of flushed) {
      expect(typeof entry.tool).toBe("string");
      expect(typeof entry.layer).toBe("string");
      expect(typeof entry.before_bytes).toBe("number");
      expect(typeof entry.after_bytes).toBe("number");
    }

    debugStore.close();
    rmDirWithRetry(debugDir);
  });

  test("emits no trace lines when SUPI_DEBUG is unset", async () => {
    delete process.env.SUPI_DEBUG;
    const debugDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-metrics-debug-"));
    const debugDb = path.join(debugDir, "metrics.db");
    const debugStore = new MetricsStore({ dbPath: debugDb, projectSlug: "trace-demo" });
    debugStore.init();

    debugStore.upsertSession({ session_id: "s1", cwd: "/tmp/x" });
    debugStore.record(row({ session_id: "s1" }));
    await debugStore.flushPendingForTest();

    expect(debugStore.tracePathForTest).toBeNull();
    const expected = path.join(path.dirname(debugDb), "metrics-trace.jsonl");
    expect(fs.existsSync(expected)).toBe(false);

    debugStore.close();
    rmDirWithRetry(debugDir);
  });

  test("emits one failure trace line per failed write when SUPI_DEBUG=1", async () => {
    process.env.SUPI_DEBUG = "1";
    const debugDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-metrics-debug-"));
    const debugDb = path.join(debugDir, "metrics.db");
    const debugStore = new MetricsStore({ dbPath: debugDb, projectSlug: "trace-demo" });
    debugStore.init();

    debugStore.upsertSession({ session_id: "s1", cwd: "/tmp/x" });
    await debugStore.flushPendingForTest();
    debugStore.close();

    debugStore.record(row({ session_id: "s1" }));
    debugStore.record(row({ session_id: "s1" }));
    await debugStore.flushPendingForTest();

    const tracePath = debugStore.tracePathForTest!;
    const lines = fs.readFileSync(tracePath, "utf-8").trim().split("\n");
    const failures = lines
      .map((l) => JSON.parse(l))
      .filter((entry: any) => entry.event === "metrics_record_after_close");
    expect(failures.length).toBe(2);

    rmDirWithRetry(debugDir);
  });
});

describe("MetricsStore network blocking (Task 28)", () => {
  test("happy path makes zero outbound network calls", async () => {
    const fetchSpy = mock(() => {
      throw new Error("fetch invoked");
    });
    const originalFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = fetchSpy;

    try {
      const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-metrics-net-"));
      const isolatedDb = path.join(isolatedDir, "metrics.db");
      const isolated = new MetricsStore({ dbPath: isolatedDb, projectSlug: "net-demo" });
      isolated.init();
      isolated.upsertSession({ session_id: "s1", cwd: "/tmp/x" });
      for (let i = 0; i < 100; i += 1) {
        isolated.record(row({ session_id: "s1", ts: Date.now() + i }));
      }
      await isolated.flushPendingForTest();
      isolated.pruneOldSessions(7);
      isolated.close();
      rmDirWithRetry(isolatedDir);
    } finally {
      (globalThis as any).fetch = originalFetch;
    }

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
