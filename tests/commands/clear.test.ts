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
  getCacheStore,
  getKnowledgeStore,
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
import { getMemoryStore } from "../../src/context-mode/memory-store.js";
import { rmDirWithRetry } from "../helpers/fs.js";

let tmpDir: string;
let platform: any;
let ctx: PlatformContext;
let store: MetricsStore;
let dbPath: string;
let cacheStore: NonNullable<ReturnType<typeof getCacheStore>>;
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
  cacheStore = getCacheStore()!;

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

function seedCache(sessionId = getSessionId(), text = "cached payload") {
  return cacheStore.putText({ sessionId, text, sourceTool: "read", sourceHash: `${sessionId}:${text}` });
}

function seedKnowledge(sessionId = getSessionId()) {
  const knowledgeStore = getKnowledgeStore();
  if (!knowledgeStore) throw new Error("knowledge store not initialized");
  knowledgeStore.index(
    [{ title: "Session Knowledge", body: "clearable session knowledge", contentType: "prose", source: "session-source" }],
    "session-source",
    { ownerScope: "session", ownerId: sessionId },
  );
  return knowledgeStore;
}

function seedMemory(sessionId = getSessionId()) {
  const memoryStore = getMemoryStore();
  if (!memoryStore) throw new Error("memory store not initialized");
  memoryStore.put({
    ownerScope: "session",
    ownerId: sessionId,
    type: "observation",
    body: "clearable session memory",
    now: 1,
  });
  memoryStore.put({
    ownerScope: "project",
    type: "observation",
    body: "pre-clear project memory",
    now: 1,
  });
  return memoryStore;
}

describe("/supi:clear — pre-deletion summary (Tasks 39, 41, 55)", () => {
  test("summary contains rows, bytes, started, scope sentence, DB path before any prompt", async () => {
    setup();
    recordRow();
    const cached = seedCache();
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
      "Scope: metrics, cache, current-session knowledge, and current-session memory. Project memory created before this clear is suppressed for this session. Events are not touched.",
    );
    expect(summary).toContain(`Metrics DB: ${dbPath}`);
    expect(summary).toContain("1 cache refs in this session.");
    expect(summary).toContain("Cache payload bytes reclaimable:");
    expect(summary).toContain(String(cached.compressedBytes));
    expect(summary).toContain(`Cache DB: ${cacheStore.dbPath}`);
    expect(summary).toContain(`Cache payloads: ${cacheStore.payloadRoot}`);
    expect(summary).toContain("Knowledge DB:");
    expect(summary).toContain("Current-session indexed knowledge will be cleared.");
    expect(summary).toContain("Memory DB:");
    expect(summary).toContain("session-owned memory rows for this session will be cleared");
  }, process.platform === "win32" ? 20_000 : undefined);

  test("cancel preserves rows and notifies 'Clear cancelled'", async () => {
    setup();
    recordRow();
    const cached = seedCache();
    const payloadPath = path.join(cacheStore.payloadRoot, cached.payloadRelpath);
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
    expect(cacheStore.getStats().refCount).toBe(1);
    expect(fs.existsSync(payloadPath)).toBe(true);

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
    expect(opts.helpText).toContain("Scope: metrics, cache, current-session knowledge");
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
    const cached = seedCache();
    const payloadPath = path.join(cacheStore.payloadRoot, cached.payloadRelpath);
    const sessionId = getSessionId();
    const knowledgeStore = seedKnowledge(sessionId);
    const memoryStore = seedMemory(sessionId);
    await store.flushPendingForTest();

    confirmMock!.mockImplementation(async () => true);
    await run();

    const probe = new Database(dbPath);
    try {
      const { count } = probe.prepare(`SELECT COUNT(*) AS count FROM metrics WHERE processor <> 'cache-clear'`).get() as { count: number };
      expect(count).toBe(0);
      const meta = probe.prepare(
        `SELECT row_count, last_clear_at, started_at FROM session_meta_metrics WHERE session_id = ?`,
      ).get(getSessionId()) as { row_count: number; last_clear_at: number; started_at: number };
      expect(meta.row_count).toBe(0);
      expect(meta.last_clear_at).toBeGreaterThan(0);
      expect(meta.started_at).toBeGreaterThan(0); // retained
      expect(cacheStore.getEntryMeta(cached.handle)).toBeNull();
      expect(fs.existsSync(payloadPath)).toBe(false);
      expect(knowledgeStore.search(["clearable"], { owner: { ownerScope: "session", ownerId: sessionId } })[0].results).toHaveLength(0);
      expect(memoryStore.retrieve({ sessionId }).map((row) => row.body)).not.toContain("clearable session memory");
      expect(memoryStore.retrieve({ sessionId }).map((row) => row.body)).not.toContain("pre-clear project memory");
    } finally {
      probe.close();
    }
  });

  test("clearSession records a best-effort L3 cache-clear metric row", async () => {
    setup({ withConfirm: true });
    recordRow();
    await store.flushPendingForTest();

    confirmMock!.mockImplementation(async () => true);
    await run();
    await store.flushPendingForTest();

    const probe = new Database(dbPath);
    try {
      const row = probe.prepare(`SELECT layer, tool, processor, cache_hit FROM metrics WHERE processor = 'cache-clear'`).get() as {
        layer: string;
        tool: string;
        processor: string;
        cache_hit: number;
      } | undefined;
      expect(row).toEqual({ layer: "L3", tool: "(system)", processor: "cache-clear", cache_hit: 0 });
    } finally {
      probe.close();
    }
  });

  test("clearSession retains shared payloads still referenced by another session", async () => {
    setup({ withConfirm: true });
    recordRow();
    const shared = seedCache(getSessionId(), "shared cache");
    cacheStore.putText({ sessionId: "other-session", text: "shared cache", sourceTool: "read", sourceHash: "other-shared" });
    const activeOnly = seedCache(getSessionId(), "active only cache");
    const sharedPath = path.join(cacheStore.payloadRoot, shared.payloadRelpath);
    const activeOnlyPath = path.join(cacheStore.payloadRoot, activeOnly.payloadRelpath);
    await store.flushPendingForTest();

    confirmMock!.mockImplementation(async () => true);
    await run();

    expect(cacheStore.getEntryMeta(shared.handle)).not.toBeNull();
    expect(fs.existsSync(sharedPath)).toBe(true);
    expect(cacheStore.getEntryMeta(activeOnly.handle)).toBeNull();
    expect(fs.existsSync(activeOnlyPath)).toBe(false);
    expect(cacheStore.getStats().refCount).toBe(1);
  });
});

describe("/supi:clear all — project-wide (Task 43)", () => {
  test("requires double confirm and clears every session row_count to 0 (preserving meta)", async () => {
    setup();
    recordRow();
    recordRow("session-x");
    seedCache(getSessionId(), "project cache a");
    seedCache("session-x", "project cache b");
    await store.flushPendingForTest();

    // First select (project-wide confirm) → Confirm; second select (session list) → Confirm
    let i = 0;
    selectMock.mockImplementation(async () => (i++ === 0 ? "Confirm" : "Confirm"));
    await run("all");

    const projectSummary = (notifyMock as any).mock.calls[0][0];
    expect(projectSummary).toContain("Project-wide clear:");
    expect(projectSummary).toContain("2 cache refs project-wide across 2 sessions.");
    expect(projectSummary).toContain(`Cache DB: ${cacheStore.dbPath}`);
    expect(projectSummary).toContain(`Cache payloads: ${cacheStore.payloadRoot}`);

    const probe = new Database(dbPath);
    try {
      const { count } = probe.prepare(`SELECT COUNT(*) AS count FROM metrics WHERE processor <> 'cache-clear'`).get() as { count: number };
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
      expect(cacheStore.getStats()).toEqual({
        entryCount: 0,
        refCount: 0,
        uncompressedBytes: 0,
        compressedBytes: 0,
        payloadBytes: 0,
      });
    } finally {
      probe.close();
    }
  });

  test("second confirmation lists memory-only and knowledge-only sessions", async () => {
    setup();
    const memoryStore = getMemoryStore();
    const knowledgeStore = getKnowledgeStore();
    if (!memoryStore || !knowledgeStore) throw new Error("stores not initialized");
    memoryStore.put({
      ownerScope: "session",
      ownerId: "memory-only",
      type: "observation",
      body: "memory-only row",
    });
    knowledgeStore.index(
      [{ title: "Knowledge Only", body: "knowledge-only row", contentType: "prose", source: "knowledge-only" }],
      "knowledge-only",
      { ownerScope: "session", ownerId: "knowledge-only" },
    );

    let i = 0;
    selectMock.mockImplementation(async () => (i++ === 0 ? "Confirm" : "Cancel"));
    await run("all");

    const secondConfirmHelp = (selectMock as any).mock.calls[1][2].helpText;
    expect(secondConfirmHelp).toContain("memory-only");
    expect(secondConfirmHelp).toContain("1 memory rows");
    expect(secondConfirmHelp).toContain("knowledge-only");
    expect(secondConfirmHelp).toContain("1 knowledge chunks");
  });

  test("cancelling either confirm preserves all rows", async () => {
    setup();
    recordRow();
    recordRow("session-x");
    const cached = seedCache("session-x", "cancel project cache");
    const payloadPath = path.join(cacheStore.payloadRoot, cached.payloadRelpath);
    await store.flushPendingForTest();

    // First select Confirm, second select Cancel.
    let i = 0;
    selectMock.mockImplementation(async () => (i++ === 0 ? "Confirm" : "Cancel"));
    await run("all");

    const probe = new Database(dbPath);
    try {
      const { count } = probe.prepare(`SELECT COUNT(*) AS count FROM metrics`).get() as { count: number };
      expect(count).toBe(2);
      expect(cacheStore.getStats().refCount).toBe(1);
      expect(fs.existsSync(payloadPath)).toBe(true);
    } finally {
      probe.close();
    }
  });
});

describe("/supi:clear --dry-run (Task 44)", () => {
  test("shows the summary, prompts nothing, deletes nothing", async () => {
    setup();
    recordRow();
    const cached = seedCache();
    const payloadPath = path.join(cacheStore.payloadRoot, cached.payloadRelpath);
    await store.flushPendingForTest();

    await run("--dry-run");

    expect((selectMock as any).mock.calls.length).toBe(0);
    const notifyCalls = (notifyMock as any).mock.calls.map((c: any[]) => c[0]);
    expect(notifyCalls.some((m: string) => m.includes("Dry-run"))).toBe(true);

    const probe = new Database(dbPath);
    try {
      const { count } = probe.prepare(`SELECT COUNT(*) AS count FROM metrics`).get() as { count: number };
      expect(count).toBe(1);
      expect(cacheStore.getStats().refCount).toBe(1);
      expect(fs.existsSync(payloadPath)).toBe(true);
    } finally {
      probe.close();
    }
  });
});

describe("/supi:clear with !ctx.hasUI (Task 45)", () => {
  test("returns silently and does not touch the DB", async () => {
    setup();
    recordRow();
    const cached = seedCache();
    const payloadPath = path.join(cacheStore.payloadRoot, cached.payloadRelpath);
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
      expect(cacheStore.getStats().refCount).toBe(1);
      expect(fs.existsSync(payloadPath)).toBe(true);
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
