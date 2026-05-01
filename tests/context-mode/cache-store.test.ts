// tests/context-mode/cache-store.test.ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { CacheStore, SCHEMA_VERSION } from "../../src/context-mode/cache-store.js";
import { MetricsStore } from "../../src/context-mode/metrics-store.js";
import { rmDirWithRetry } from "../helpers/fs.js";

let tmpDir: string;
let dbPath: string;
let payloadRoot: string;
let store: CacheStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-cache-"));
  dbPath = path.join(tmpDir, "cache.db");
  payloadRoot = path.join(tmpDir, "cache-payloads");
  store = new CacheStore({ dbPath, payloadRoot, projectSlug: "demo" });
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
});

describe("CacheStore schema and lifecycle", () => {
  test("init creates cache.db, payload root, schema, and schema version", () => {
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(fs.statSync(payloadRoot).isDirectory()).toBe(true);

    const probe = new Database(dbPath, { readonly: true });
    try {
      const found = probe
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('cache_entries','cache_refs')`,
        )
        .all() as Array<{ name: string }>;
      const names = new Set(found.map((row) => row.name));

      expect(names.has("cache_entries")).toBe(true);
      expect(names.has("cache_refs")).toBe(true);

      const { user_version } = probe.prepare(`PRAGMA user_version`).get() as {
        user_version: number;
      };
      expect(user_version).toBe(SCHEMA_VERSION);
    } finally {
      probe.close();
    }
  });

  test("init uses DELETE journal mode when SQLite permits it", () => {
    const probe = new Database(dbPath, { readonly: true });
    try {
      const { journal_mode } = probe.prepare(`PRAGMA journal_mode`).get() as {
        journal_mode: string;
      };

      expect(journal_mode.toLowerCase()).toBe("delete");
    } finally {
      probe.close();
    }
  });

  test("exposes paths and empty stats", () => {
    expect(store.dbPath).toBe(dbPath);
    expect(store.payloadRoot).toBe(payloadRoot);
    expect(store.projectSlug).toBe("demo");
    expect(store.getStats()).toEqual({
      entryCount: 0,
      refCount: 0,
      uncompressedBytes: 0,
      compressedBytes: 0,
      payloadBytes: 0,
    });
  });

  test("close is idempotent", () => {
    expect(() => store.close()).not.toThrow();
    expect(() => store.close()).not.toThrow();

    store = new CacheStore({ dbPath, payloadRoot, projectSlug: "demo" });
    store.init();
  });
});

describe("CacheStore Brotli put/open", () => {
  test("putText stores Brotli payload metadata and openText rehydrates after restart", () => {
    const text = "hello cached world\nwith another line";
    const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
    const handle = `cache://${sha256}`;

    const put = store.putText({ sessionId: "s1", text, sourceTool: "read", sourceHash: "src-1", now: 1234 });

    expect(put.handle).toBe(handle);
    expect(put.sha256).toBe(sha256);
    expect(put.preview).toBe(text);
    expect(put.sizeBytes).toBe(Buffer.byteLength(text, "utf8"));
    expect(put.compressedBytes).toBeGreaterThan(0);

    const payloadPath = path.join(payloadRoot, sha256.slice(0, 2), `${sha256}.br`);
    expect(fs.existsSync(payloadPath)).toBe(true);
    expect(fs.statSync(payloadPath).size).toBe(put.compressedBytes);

    const probe = new Database(dbPath, { readonly: true });
    try {
      const row = probe.prepare(`SELECT handle, sha256, preview, payload_relpath FROM cache_entries WHERE handle = ?`).get(handle) as {
        handle: string;
        sha256: string;
        preview: string;
        payload_relpath: string;
      };
      expect(row).toEqual({
        handle,
        sha256,
        preview: text,
        payload_relpath: path.join(sha256.slice(0, 2), `${sha256}.br`),
      });
    } finally {
      probe.close();
    }

    store.close();
    store = new CacheStore({ dbPath, payloadRoot, projectSlug: "demo" });
    store.init();

    const opened = store.openText(handle);
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.text).toBe(text);
      expect(opened.meta.handle).toBe(handle);
      expect(opened.meta.openCount).toBe(1);
    }
  });

  test("identical text deduplicates payload entries while retaining session refs", () => {
    const first = store.putText({ sessionId: "s1", text: "same payload", sourceTool: "read", sourceHash: "a" });
    const second = store.putText({ sessionId: "s2", text: "same payload", sourceTool: "search", sourceHash: "b" });

    expect(second.handle).toBe(first.handle);
    expect(store.getStats()).toEqual({
      entryCount: 1,
      refCount: 2,
      uncompressedBytes: first.sizeBytes,
      compressedBytes: first.compressedBytes,
      payloadBytes: first.compressedBytes,
    });
  });
});

function payloadPathFor(handle: string): string {
  const meta = store.getEntryMeta(handle);
  if (!meta) throw new Error(`missing cache metadata for ${handle}`);
  return path.join(payloadRoot, meta.payloadRelpath);
}

describe("CacheStore refs, clear, prune, and corruption handling", () => {
  test("clearSession removes only that session's refs and garbage-collects unreferenced payloads", () => {
    const shared = store.putText({ sessionId: "s1", text: "shared", sourceTool: "read", sourceHash: "shared-s1" });
    store.putText({ sessionId: "s2", text: "shared", sourceTool: "read", sourceHash: "shared-s2" });
    const sessionOnly = store.putText({ sessionId: "s1", text: "session-only", sourceTool: "search", sourceHash: "only" });
    const sharedPayloadPath = payloadPathFor(shared.handle);
    const sessionOnlyPayloadPath = payloadPathFor(sessionOnly.handle);

    const cleared = store.clearSession("s1", 5000);

    expect(cleared).toEqual({
      deletedRefs: 2,
      deletedEntries: 1,
      deletedPayloadBytes: sessionOnly.compressedBytes,
      retainedPayloadBytes: shared.compressedBytes,
    });
    expect(fs.existsSync(sharedPayloadPath)).toBe(true);
    expect(fs.existsSync(sessionOnlyPayloadPath)).toBe(false);
    expect(store.getEntryMeta(shared.handle)).not.toBeNull();
    expect(store.getEntryMeta(sessionOnly.handle)).toBeNull();
    expect(store.getStats()).toEqual({
      entryCount: 1,
      refCount: 1,
      uncompressedBytes: shared.sizeBytes,
      compressedBytes: shared.compressedBytes,
      payloadBytes: shared.compressedBytes,
    });
  });

  test("clearProject removes all refs, entries, and payload files", () => {
    const a = store.putText({ sessionId: "s1", text: "alpha", sourceTool: "read", sourceHash: "a" });
    const b = store.putText({ sessionId: "s2", text: "bravo", sourceTool: "read", sourceHash: "b" });
    const totalPayloadBytes = a.compressedBytes + b.compressedBytes;

    expect(store.clearProject(6000)).toEqual({
      deletedRefs: 2,
      deletedEntries: 2,
      deletedPayloadBytes: totalPayloadBytes,
      retainedPayloadBytes: 0,
    });
    expect(store.getStats()).toEqual({
      entryCount: 0,
      refCount: 0,
      uncompressedBytes: 0,
      compressedBytes: 0,
      payloadBytes: 0,
    });
    expect(store.getEntryMeta(a.handle)).toBeNull();
    expect(store.getEntryMeta(b.handle)).toBeNull();
  });

  test("pruneOldSessions removes old refs and garbage-collects entries with no remaining refs", () => {
    const day = 24 * 60 * 60 * 1000;
    const now = 10 * day;
    const oldOnly = store.putText({ sessionId: "old", text: "old-only", sourceTool: "read", sourceHash: "old", now: 0 });
    const shared = store.putText({ sessionId: "old", text: "shared", sourceTool: "read", sourceHash: "old-shared", now: 0 });
    store.putText({ sessionId: "recent", text: "shared", sourceTool: "read", sourceHash: "recent-shared", now });

    const result = store.pruneOldSessions(7, now);

    expect(result).toEqual({
      deletedRefs: 2,
      deletedEntries: 1,
      deletedPayloadBytes: oldOnly.compressedBytes,
      retainedPayloadBytes: shared.compressedBytes,
    });
    expect(store.getEntryMeta(oldOnly.handle)).toBeNull();
    expect(store.getEntryMeta(shared.handle)).not.toBeNull();
    expect(store.getStats().refCount).toBe(1);
  });

  test("openText returns typed failures for missing and corrupt payload files", () => {
    const missing = store.putText({ sessionId: "s1", text: "missing payload", sourceTool: "read", sourceHash: "missing" });
    fs.unlinkSync(payloadPathFor(missing.handle));

    expect(store.openText(missing.handle)).toEqual({
      ok: false,
      reason: "missing_payload",
      handle: missing.handle,
      message: `Cannot open cached content: payload file is missing for ${missing.handle}.`,
    });

    const corrupt = store.putText({ sessionId: "s1", text: "corrupt payload", sourceTool: "read", sourceHash: "corrupt" });
    fs.writeFileSync(payloadPathFor(corrupt.handle), "not brotli");

    expect(store.openText(corrupt.handle)).toEqual({
      ok: false,
      reason: "corrupt_payload",
      handle: corrupt.handle,
      message: `Cannot open cached content: payload is corrupt for ${corrupt.handle}.`,
    });
  });
});

describe("CacheStore L3 metrics", () => {
  test("putText records a best-effort cache-store row when metrics are available", async () => {
    const metrics = new MetricsStore({ dbPath: path.join(tmpDir, "metrics.db"), projectSlug: "demo" });
    metrics.init();
    store.close();
    store = new CacheStore({ dbPath, payloadRoot, projectSlug: "demo", metricsStore: metrics });
    store.init();

    const put = store.putText({ sessionId: "s1", text: "metric payload", sourceTool: "read", sourceHash: "m" });
    await metrics.flushPendingForTest();

    const probe = new Database(metrics.dbPath);
    try {
      const row = probe.prepare(`SELECT layer, tool, processor, before_bytes, after_bytes, cache_hit FROM metrics`).get() as {
        layer: string;
        tool: string;
        processor: string;
        before_bytes: number;
        after_bytes: number;
        cache_hit: number;
      };
      expect(row).toEqual({
        layer: "L3",
        tool: "(system)",
        processor: "cache-store",
        before_bytes: put.sizeBytes,
        after_bytes: 0,
        cache_hit: 0,
      });
    } finally {
      probe.close();
      metrics.close();
    }
  });

  test("pruneOldSessions records a best-effort cache-prune row", async () => {
    const metrics = new MetricsStore({ dbPath: path.join(tmpDir, "metrics.db"), projectSlug: "demo" });
    metrics.init();
    store.close();
    store = new CacheStore({ dbPath, payloadRoot, projectSlug: "demo", metricsStore: metrics, metricsSessionId: "system" });
    store.init();

    const day = 24 * 60 * 60 * 1000;
    const oldOnly = store.putText({ sessionId: "old", text: "old metric", sourceTool: "read", sourceHash: "old", now: 0 });
    const shared = store.putText({ sessionId: "old", text: "shared metric", sourceTool: "read", sourceHash: "old-shared", now: 0 });
    store.putText({ sessionId: "recent", text: "shared metric", sourceTool: "read", sourceHash: "recent-shared", now: 10 * day });
    await metrics.flushPendingForTest();

    store.pruneOldSessions(7, 10 * day);
    await metrics.flushPendingForTest();

    const probe = new Database(metrics.dbPath);
    try {
      const row = probe.prepare(`SELECT layer, tool, processor, before_bytes, after_bytes, cache_hit FROM metrics WHERE processor = 'cache-prune'`).get() as {
        layer: string;
        tool: string;
        processor: string;
        before_bytes: number;
        after_bytes: number;
        cache_hit: number;
      };
      expect(row).toEqual({
        layer: "L3",
        tool: "(system)",
        processor: "cache-prune",
        before_bytes: oldOnly.compressedBytes + shared.compressedBytes,
        after_bytes: shared.compressedBytes,
        cache_hit: 0,
      });
    } finally {
      probe.close();
      metrics.close();
    }
  });

  test("metrics failures do not break cache writes or pruning", () => {
    const throwingMetrics = { record: mock(() => { throw new Error("metrics down"); }) };
    store.close();
    store = new CacheStore({ dbPath, payloadRoot, projectSlug: "demo", metricsStore: throwingMetrics as any });
    store.init();

    expect(() => {
      store.putText({ sessionId: "s1", text: "still stores", sourceTool: "read", sourceHash: "ok", now: 0 });
      store.pruneOldSessions(7, 10 * 24 * 60 * 60 * 1000);
    }).not.toThrow();
    expect(store.getStats().entryCount).toBe(0);
  });
});
