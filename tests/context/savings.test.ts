// tests/context/savings.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  MetricsStore,
  type MetricRow,
} from "../../src/context-mode/metrics-store.js";
import {
  _internals,
  buildSavingsLines,
  buildSavingsLinesFromStore,
  formatSavingsReport,
  formatSavingsReportFromStore,
  getFirstRunNotice,
} from "../../src/context/savings.js";
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-savings-"));
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
  rmDirWithRetry(tmpDir);
});

describe("getFirstRunNotice", () => {
  test("emits the notice once and persists the marker", () => {
    const first = getFirstRunNotice(store, "demo", dbPath);
    expect(first).not.toBeNull();
    expect(first!).toContain("Measurement enabled");
    expect(first!).toContain(dbPath);
    expect(store.getProjectMeta("demo")?.first_run_notice_shown_at).not.toBeNull();

    const second = getFirstRunNotice(store, "demo", dbPath);
    expect(second).toBeNull();
  });

  test("returns null gracefully when the store is null", () => {
    expect(getFirstRunNotice(null, "demo", dbPath)).toBeNull();
  });

  test("notice persists across process restarts", () => {
    const first = getFirstRunNotice(store, "demo", dbPath);
    expect(first).not.toBeNull();
    store.close();

    const reopened = new MetricsStore({ dbPath, projectSlug: "demo" });
    reopened.init();
    try {
      const again = getFirstRunNotice(reopened, "demo", dbPath);
      expect(again).toBeNull();
    } finally {
      reopened.close();
    }

    // Replace the closed handle so afterEach's close is a no-op.
    store = new MetricsStore({ dbPath, projectSlug: "demo" });
    store.init();
  });

  test("Task 53 — notice copy matches the documented snapshot", () => {
    const expectedPrefix = _internals.FIRST_RUN_NOTICE_PREFIX;
    const expectedSuffix = _internals.FIRST_RUN_NOTICE_SUFFIX;
    const notice = getFirstRunNotice(store, "demo", "/abs/metrics.db");
    expect(notice).toBe(`${expectedPrefix}/abs/metrics.db${expectedSuffix}`);
  });
});

describe("buildSavingsLines", () => {
  test("renders exactly 4 lines in the documented order", () => {
    const lines = buildSavingsLines({
      session: { id: "abcd1234ef", startedAt: Date.now() - 3_600_000, rowCount: 12 },
      totals: { beforeBytes: 12000, afterBytes: 4000, saved: 8000, tokensEstimated: 2000 },
      perCompressor: [
        { compressor: "bash", saved: 5000, calls: 5 },
        { compressor: "read", saved: 2000, calls: 6 },
        { compressor: "grep", saved: 1000, calls: 1 },
      ],
      uniqueSourceShare: 0.42,
    });

    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("Session:");
    expect(lines[0]).toContain("Started:");
    expect(lines[0]).toContain("Compressors tracked: 3");
    expect(lines[1]).toContain("Saved this session:");
    expect(lines[2]).toContain("Top compressors:");
    expect(lines[2]).toContain("bash");
    expect(lines[3]).toContain("Unique-source share: 42%");
  });

  test("empty perCompressor renders 'Top compressors: (none)'", () => {
    const lines = buildSavingsLines({
      session: { id: "x", startedAt: null, rowCount: 0 },
      totals: { beforeBytes: 0, afterBytes: 0, saved: 0, tokensEstimated: 0 },
      perCompressor: [],
      uniqueSourceShare: 0,
    });
    expect(lines[2]).toBe("Top compressors: (none)");
  });

  test("does NOT emit the Metrics DB footer (consumer owns it)", () => {
    const lines = buildSavingsLines({
      session: { id: "x", startedAt: null, rowCount: 0 },
      totals: { beforeBytes: 0, afterBytes: 0, saved: 0, tokensEstimated: 0 },
      perCompressor: [],
      uniqueSourceShare: 0,
    });
    expect(lines.some((l) => l.startsWith("Metrics DB:"))).toBe(false);
  });
});

describe("buildSavingsLinesFromStore", () => {
  test("null store returns exactly two lines (session + fallback)", () => {
    const lines = buildSavingsLinesFromStore(null, "abc12345", Date.now(), dbPath);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Session:");
    expect(lines[0]).toContain("Compressors tracked: 0");
    expect(lines[1]).toBe(_internals.FALLBACK_LINE);
  });

  test("null store with null startedAt renders Started: unknown", () => {
    const lines = buildSavingsLinesFromStore(null, "abc", null, dbPath);
    expect(lines[0]).toContain("Started: unknown");
  });

  test("non-null store delegates to buildSavingsLines (4 lines)", async () => {
    store.upsertSession({ session_id: "s1", cwd: "/tmp" });
    store.record(row({ session_id: "s1", before_bytes: 1000, after_bytes: 100 }));
    await store.flushPendingForTest();

    const lines = buildSavingsLinesFromStore(store, "s1", Date.now(), dbPath);
    expect(lines).toHaveLength(4);
    expect(lines[2]).toContain("bash");
  });

  test("never includes the Metrics DB footer", () => {
    const lines = buildSavingsLinesFromStore(null, "x", null, "/abs/metrics.db");
    expect(lines.some((l) => l.startsWith("Metrics DB:"))).toBe(false);
  });
});

describe("formatSavingsReport", () => {
  test("emits the documented headings", () => {
    const md = formatSavingsReport({
      session: { id: "s1", startedAt: Date.now() - 60_000, rowCount: 3 },
      totals: { beforeBytes: 1000, afterBytes: 100, saved: 900, tokensEstimated: 225 },
      perCompressor: [{ compressor: "bash", saved: 900, calls: 3 }],
      uniqueSourceShare: 0.5,
    });

    expect(md).toContain("# Session savings");
    expect(md).toContain("## Totals");
    expect(md).toContain("## Top compressors");
    expect(md).toContain("## Unique-source share");
  });

  test("renders zero-state message when no compressors were tracked", () => {
    const md = formatSavingsReport({
      session: { id: "s1", startedAt: null, rowCount: 0 },
      totals: { beforeBytes: 0, afterBytes: 0, saved: 0, tokensEstimated: 0 },
      perCompressor: [],
      uniqueSourceShare: 0,
    });
    expect(md).toContain("(no compressors tracked yet)");
  });

  test("renders metrics recorded with all L2 processor keys", async () => {
    store.upsertSession({ session_id: "s1", cwd: "/tmp" });
    const processors = ["git", "test", "lint", "build", "k8s", "docker", "log", "json", "dedup"] as const;
    for (const processor of processors) {
      store.record(row({
        session_id: "s1",
        tool: "bash",
        processor,
        before_bytes: 1000,
        after_bytes: 100,
      }));
    }
    await store.flushPendingForTest();

    expect(store.getSessionTotals("s1")).toMatchObject({
      beforeBytes: 9000,
      afterBytes: 900,
      saved: 8100,
      rowCount: 9,
    });

    const report = formatSavingsReportFromStore(store, "s1", Date.now())!;
    expect(report).toContain("- Saved: 7.9KB");
    for (const processor of processors) {
      expect(report).toContain(`- ${processor} —`);
    }
  });
});
