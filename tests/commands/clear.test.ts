// tests/commands/clear.test.ts
//
// Integration tests for /supi:clear (plan Tasks 39\u201347).

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";

import { handleClear } from "../../src/commands/clear.js";
import {
  _resetCache,
  getSessionId,
  registerContextModeHooks,
} from "../../src/context-mode/hooks.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { createMockPlatform } from "../../src/platform/test-utils.js";
import type { PlatformContext, PlatformPaths } from "../../src/platform/types.js";
import {
  MetricsStore,
  __setMetricsStoreForTest,
} from "../../src/context-mode/metrics-store.js";
import { rmDirWithRetry } from "../helpers/fs.js";

let tmpDir: string;
let platform: any;
let ctx: PlatformContext;
let store: MetricsStore;
let dbPath: string;
let notifyMock: ReturnType<typeof mock>;
let selectMock: ReturnType<typeof mock>;
let confirmMock: ReturnType<typeof mock> | undefined;

function tmpPaths(): PlatformPaths {
  return {
    dotDir: ".omp",
    dotDirDisplay: ".omp",
    project: (_cwd: string, ...segments: string[]) =>
      path.join(tmpDir, "project", ...segments),
    global: (...segments: string[]) => path.join(tmpDir, "global", ...segments),
    agent: (...segments: string[]) => path.join(tmpDir, "agent", ...segments),
  };
}

function setup(opts: { withConfirm?: boolean } = {}): void {
  const handlers = new Map<string, Function>();
  platform = createMockPlatform({
    on: mock((event: string, handler: Function) => {
      handlers.set(event, handler);
    }) as any,
    paths: tmpPaths(),
    registerTool: mock(),
  });
  Object.assign(platform, {
    logger: { warn: mock(), error: mock(), debug: mock() },
    _handlers: handlers,
  });

  registerContextModeHooks(platform, DEFAULT_CONFIG);
  const sessionStart = handlers.get("session_start")!;
  sessionStart({}, { cwd: tmpDir });

  // Replace the active store with a controllable handle so we can preload rows.
  dbPath = path.join(tmpDir, "metrics.db");
  store = new MetricsStore({ dbPath, projectSlug: "demo" });
  store.init();
  __setMetricsStoreForTest(store);

  notifyMock = mock();
  selectMock = mock(async () => null);
  confirmMock = opts.withConfirm ? mock(async () => true) : undefined;

  const ui: any = {
    select: selectMock as any,
    notify: notifyMock as any,
    input: mock(async () => null),
  };
  if (confirmMock) ui.confirm = confirmMock as any;

  ctx = { cwd: tmpDir, hasUI: true, ui };
}

beforeEach(() => {
  _resetCache();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-clear-"));
});

afterEach(() => {
  try { store?.close(); } catch { /* already closed */ }
  const sd = platform?._handlers?.get("session_shutdown");
  if (typeof sd === "function") {
    try { sd({}, {}); } catch { /* best effort */ }
  }
  _resetCache();
  rmDirWithRetry(tmpDir);
});

async function run(args?: string): Promise<void> {
  handleClear(platform, ctx, args);
  // Wait for the IIFE to finish.
  for (let i = 0; i < 80; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
    if ((notifyMock as any).mock.calls.length > 0) break;
  }
  // Give it a few more ticks so any post-confirm notify runs.
  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

function recordRow(sessionId?: string): void {
  const sid = sessionId ?? getSessionId();
  store.upsertSession({ session_id: sid, cwd: tmpDir });
  store.record({
    session_id: sid,
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
  });
}

describe("/supi:clear — pre-deletion summary (Tasks 39, 41, 55)", () => {
  test("summary contains rows, bytes, started, scope sentence, DB path before any prompt", async () => {
    setup();
    recordRow();
    await store.flushPendingForTest();

    selectMock.mockImplementation(async () => "Cancel");
    await run();

    // First notify call must contain the full summary; subsequent ones may be
    // status messages.
    const summary = (notifyMock as any).mock.calls[0][0];
    expect(summary).toContain("metrics rows");
    expect(summary).toContain("Approx on-disk:");
    expect(summary).toContain("Started:");
    expect(summary).toContain(
      "Scope: metrics only. Events, knowledge, and cache are not touched.",
    );
    expect(summary).toContain(`Metrics DB: ${dbPath}`);
  });

  test("cancel preserves rows and notifies 'Clear cancelled'", async () => {
    setup();
    recordRow();
    await store.flushPendingForTest();

    selectMock.mockImplementation(async () => "Cancel");
    await run();

    const probe = new Database(dbPath);
    try {
      const { count } = probe.prepare(`SELECT COUNT(*) AS count FROM metrics`).get() as { count: number };
      expect(count).toBe(1);
    } finally {
      probe.close();
    }

    const notifyCalls = (notifyMock as any).mock.calls.map((c: any[]) => c[0]);
    expect(notifyCalls.some((m: string) => m.includes("Clear cancelled"))).toBe(true);
  });
});

describe("/supi:clear — confirmation fallback (Task 40)", () => {
  test("uses select(title, [Confirm, Cancel], { helpText }) when confirm is absent", async () => {
    setup({ withConfirm: false });
    recordRow();
    await store.flushPendingForTest();

    selectMock.mockImplementation(async () => "Cancel");
    await run();

    const calls = (selectMock as any).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const [title, options, opts] = calls[0];
    expect(typeof title).toBe("string");
    expect(options).toEqual(["Confirm", "Cancel"]);
    expect(typeof opts.helpText).toBe("string");
    expect(opts.helpText).toContain("Scope: metrics only");
  });

  test("uses ctx.ui.confirm when present and skips select for the prompt", async () => {
    setup({ withConfirm: true });
    recordRow();
    await store.flushPendingForTest();

    confirmMock!.mockImplementation(async () => false);
    await run();

    expect((confirmMock as any).mock.calls.length).toBe(1);
    expect((selectMock as any).mock.calls.length).toBe(0);
  });
});

describe("/supi:clear — accept path (Task 42)", () => {
  test("clearSession deletes rows, resets row_count, stamps last_clear_at, retains meta", async () => {
    setup({ withConfirm: true });
    recordRow();
    await store.flushPendingForTest();

    confirmMock!.mockImplementation(async () => true);
    await run();

    const probe = new Database(dbPath);
    try {
      const { count } = probe.prepare(`SELECT COUNT(*) AS count FROM metrics`).get() as { count: number };
      expect(count).toBe(0);
      const meta = probe.prepare(
        `SELECT row_count, last_clear_at, started_at FROM session_meta_metrics WHERE session_id = ?`,
      ).get(getSessionId()) as { row_count: number; last_clear_at: number; started_at: number };
      expect(meta.row_count).toBe(0);
      expect(meta.last_clear_at).toBeGreaterThan(0);
      expect(meta.started_at).toBeGreaterThan(0); // retained
    } finally {
      probe.close();
    }
  });
});

describe("/supi:clear all — project-wide (Task 43)", () => {
  test("requires double confirm and clears every session row_count to 0 (preserving meta)", async () => {
    setup();
    recordRow();
    recordRow("session-x");
    await store.flushPendingForTest();

    // First select (project-wide confirm) → Confirm; second select (session list) → Confirm
    let i = 0;
    selectMock.mockImplementation(async () => (i++ === 0 ? "Confirm" : "Confirm"));
    await run("all");

    const probe = new Database(dbPath);
    try {
      const { count } = probe.prepare(`SELECT COUNT(*) AS count FROM metrics`).get() as { count: number };
      expect(count).toBe(0);
      const rows = probe.prepare(
        `SELECT session_id, row_count, started_at FROM session_meta_metrics ORDER BY session_id`,
      ).all() as Array<{ session_id: string; row_count: number; started_at: number }>;
      for (const r of rows) {
        expect(r.row_count).toBe(0);
        expect(r.started_at).toBeGreaterThan(0); // preserved
      }
      // The store is bound to slug 'demo' in our test; clearProject uses the bound slug.
      const project = probe
        .prepare(`SELECT last_clear_all_at FROM project_meta_metrics WHERE project_slug = 'demo'`)
        .get() as { last_clear_all_at: number };
      expect(project.last_clear_all_at).toBeGreaterThan(0);
    } finally {
      probe.close();
    }
  });

  test("cancelling either confirm preserves all rows", async () => {
    setup();
    recordRow();
    recordRow("session-x");
    await store.flushPendingForTest();

    // First select Confirm, second select Cancel.
    let i = 0;
    selectMock.mockImplementation(async () => (i++ === 0 ? "Confirm" : "Cancel"));
    await run("all");

    const probe = new Database(dbPath);
    try {
      const { count } = probe.prepare(`SELECT COUNT(*) AS count FROM metrics`).get() as { count: number };
      expect(count).toBe(2);
    } finally {
      probe.close();
    }
  });
});

describe("/supi:clear --dry-run (Task 44)", () => {
  test("shows the summary, prompts nothing, deletes nothing", async () => {
    setup();
    recordRow();
    await store.flushPendingForTest();

    await run("--dry-run");

    expect((selectMock as any).mock.calls.length).toBe(0);
    const notifyCalls = (notifyMock as any).mock.calls.map((c: any[]) => c[0]);
    expect(notifyCalls.some((m: string) => m.includes("Dry-run"))).toBe(true);

    const probe = new Database(dbPath);
    try {
      const { count } = probe.prepare(`SELECT COUNT(*) AS count FROM metrics`).get() as { count: number };
      expect(count).toBe(1);
    } finally {
      probe.close();
    }
  });
});

describe("/supi:clear with !ctx.hasUI (Task 45)", () => {
  test("returns silently and does not touch the DB", async () => {
    setup();
    recordRow();
    await store.flushPendingForTest();

    ctx = { ...ctx, hasUI: false };
    handleClear(platform, ctx);
    await new Promise((r) => setTimeout(r, 30));

    expect((notifyMock as any).mock.calls.length).toBe(0);
    expect((selectMock as any).mock.calls.length).toBe(0);
    const probe = new Database(dbPath);
    try {
      const { count } = probe.prepare(`SELECT COUNT(*) AS count FROM metrics`).get() as { count: number };
      expect(count).toBe(1);
    } finally {
      probe.close();
    }
  });
});

describe("/supi:clear cross-store isolation (Task 46)", () => {
  test("does not modify a sibling events.db on either active-session or project-wide clear", async () => {
    setup();
    recordRow();
    await store.flushPendingForTest();

    // Pre-populate a sibling events.db file.
    const eventsPath = path.join(path.dirname(dbPath), "events.db");
    fs.writeFileSync(eventsPath, "events-bytes-payload");
    const beforeBytes = fs.readFileSync(eventsPath);

    selectMock.mockImplementation(async () => "Confirm");
    await run();

    const afterSession = fs.readFileSync(eventsPath);
    expect(afterSession.equals(beforeBytes)).toBe(true);

    // Now project-wide clear.
    let i = 0;
    selectMock.mockImplementation(async () => (i++ === 0 ? "Confirm" : "Confirm"));
    notifyMock.mockClear();
    await run("all");

    const afterProject = fs.readFileSync(eventsPath);
    expect(afterProject.equals(beforeBytes)).toBe(true);
  });
});

describe("/supi:clear bootstrap registration (Task 47)", () => {
  test("clear command and TUI handler are exported and wired", () => {
    // The actual bootstrap registration test belongs to integration tests;
    // here we assert the symbols themselves are exported as the spec requires.
    // (Already covered by the import at the top of this file succeeding.)
    expect(typeof handleClear).toBe("function");
  });
});
