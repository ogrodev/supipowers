import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  acquireUltraPlanBatchActiveRunLease,
  appendUltraPlanBatchJournalEvent,
  clearUltraPlanBatchActiveRunLease,
  loadUltraPlanActiveBatchRun,
  loadUltraPlanBatchActiveRunLease,
  loadUltraPlanBatchJournal,
  loadUltraPlanBatchRun,
  releaseUltraPlanBatchActiveRunLease,
  saveUltraPlanBatchActiveRunLease,
  saveUltraPlanBatchRun,
} from "../../../src/ultraplan/batch/storage.js";
import {
  getUltraplanActiveBatchRunPath,
  getUltraplanBatchJournalPath,
  getUltraplanBatchRunPath,
} from "../../../src/ultraplan/project-paths.js";
import {
  createTestPaths,
  createTestRepo,
  makeUltraPlanBatchActiveRunLease,
  makeUltraPlanBatchJournalEvent,
  makeUltraPlanBatchNode,
  makeUltraPlanBatchRun,
} from "../fixtures.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-ultraplan-batch-storage-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("ultraplan batch storage", () => {
  test("saves and loads run.json with schema validation", () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    const run = makeUltraPlanBatchRun();

    const saved = saveUltraPlanBatchRun(paths, cwd, run);
    expect(saved.ok).toBe(true);
    expect(saved.ok ? saved.value : "").toBe(getUltraplanBatchRunPath(paths, cwd, run.runId));
    expect(loadUltraPlanBatchRun(paths, cwd, run.runId)).toEqual({ ok: true, value: run });
  });

  test("appends journal entries and reads them back in order", () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    const run = makeUltraPlanBatchRun();
    const created = makeUltraPlanBatchJournalEvent();
    const acquired = makeUltraPlanBatchJournalEvent({
      type: "lease-acquired",
      summary: "Lease acquired by main-session-1",
      recordedAt: "2026-04-21T12:01:00.000Z",
    });

    saveUltraPlanBatchRun(paths, cwd, run);
    expect(appendUltraPlanBatchJournalEvent(paths, cwd, run.runId, created).ok).toBe(true);
    expect(appendUltraPlanBatchJournalEvent(paths, cwd, run.runId, acquired).ok).toBe(true);
    expect(loadUltraPlanBatchJournal(paths, cwd, run.runId)).toEqual({ ok: true, value: [created, acquired] });
    expect(fs.existsSync(getUltraplanBatchJournalPath(paths, cwd, run.runId))).toBe(true);
  });

  test("acquires a live lease and rejects a second live owner", () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    const firstLease = makeUltraPlanBatchActiveRunLease();
    const secondLease = makeUltraPlanBatchActiveRunLease({
      ownerSessionId: "main-session-2",
      leaseAcquiredAt: "2026-04-21T12:01:00.000Z",
      leaseExpiresAt: "2026-04-21T12:06:00.000Z",
      updatedAt: "2026-04-21T12:01:00.000Z",
    });

    expect(
      acquireUltraPlanBatchActiveRunLease(paths, cwd, firstLease, { nowIso: "2026-04-21T12:00:30.000Z" }),
    ).toEqual({ ok: true, value: firstLease });
    const second = acquireUltraPlanBatchActiveRunLease(
      paths,
      cwd,
      secondLease,
      { nowIso: "2026-04-21T12:01:30.000Z" },
    );
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.kind).toBe("validation-error");
    }
    expect(loadUltraPlanBatchActiveRunLease(paths, cwd)).toEqual({ ok: true, value: firstLease });
  });

  test("allows the active owner to renew a live lease", () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    const firstLease = makeUltraPlanBatchActiveRunLease();
    const renewedLease = makeUltraPlanBatchActiveRunLease({
      leaseAcquiredAt: "2026-04-21T12:02:00.000Z",
      leaseExpiresAt: "2026-04-21T12:07:00.000Z",
      updatedAt: "2026-04-21T12:02:00.000Z",
    });

    expect(acquireUltraPlanBatchActiveRunLease(paths, cwd, firstLease, { nowIso: "2026-04-21T12:00:30.000Z" })).toEqual({ ok: true, value: firstLease });
    expect(acquireUltraPlanBatchActiveRunLease(paths, cwd, renewedLease, { nowIso: "2026-04-21T12:02:00.000Z" })).toEqual({ ok: true, value: renewedLease });
    expect(loadUltraPlanBatchActiveRunLease(paths, cwd)).toEqual({ ok: true, value: renewedLease });
  });

  test("reclaims an expired lease", () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    const expiredLease = makeUltraPlanBatchActiveRunLease({
      ownerSessionId: "old-owner",
      leaseAcquiredAt: "2026-04-21T12:00:00.000Z",
      leaseExpiresAt: "2026-04-21T12:01:00.000Z",
      updatedAt: "2026-04-21T12:00:00.000Z",
    });
    const replacement = makeUltraPlanBatchActiveRunLease({
      ownerSessionId: "new-owner",
      leaseAcquiredAt: "2026-04-21T12:02:00.000Z",
      leaseExpiresAt: "2026-04-21T12:07:00.000Z",
      updatedAt: "2026-04-21T12:02:00.000Z",
    });

    expect(saveUltraPlanBatchActiveRunLease(paths, cwd, expiredLease).ok).toBe(true);
    expect(acquireUltraPlanBatchActiveRunLease(paths, cwd, replacement, { nowIso: "2026-04-21T12:02:00.000Z" })).toEqual({ ok: true, value: replacement });
    expect(loadUltraPlanBatchActiveRunLease(paths, cwd)).toEqual({ ok: true, value: replacement });
  });

  test("rejects future-dated acquisition attempts and live-lease steals based on trusted nowIso", () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    const futureLease = makeUltraPlanBatchActiveRunLease({
      leaseAcquiredAt: "2026-04-21T12:10:00.000Z",
      leaseExpiresAt: "2026-04-21T12:15:00.000Z",
      updatedAt: "2026-04-21T12:10:00.000Z",
    });
    expect(
      acquireUltraPlanBatchActiveRunLease(paths, cwd, futureLease, { nowIso: "2026-04-21T12:09:00.000Z" }),
    ).toMatchObject({ ok: false, error: { kind: "validation-error" } });

    const heldLease = makeUltraPlanBatchActiveRunLease({
      ownerSessionId: "other-owner",
      leaseAcquiredAt: "2026-04-21T12:00:00.000Z",
      leaseExpiresAt: "2026-04-21T12:04:00.000Z",
      updatedAt: "2026-04-21T12:00:00.000Z",
    });
    const attemptedSteal = makeUltraPlanBatchActiveRunLease({
      ownerSessionId: "new-owner",
      leaseAcquiredAt: "2026-04-21T12:05:00.000Z",
      leaseExpiresAt: "2026-04-21T12:10:00.000Z",
      updatedAt: "2026-04-21T12:05:00.000Z",
    });
    expect(saveUltraPlanBatchActiveRunLease(paths, cwd, heldLease).ok).toBe(true);
    expect(
      acquireUltraPlanBatchActiveRunLease(paths, cwd, attemptedSteal, { nowIso: "2026-04-21T12:03:00.000Z" }),
    ).toMatchObject({ ok: false, error: { kind: "validation-error" } });
    expect(loadUltraPlanBatchActiveRunLease(paths, cwd)).toEqual({ ok: true, value: heldLease });
  });

  test("releases ownerSessionId and lease fields when a batch returns to paused or blocked", () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    const lease = makeUltraPlanBatchActiveRunLease();

    expect(saveUltraPlanBatchActiveRunLease(paths, cwd, lease).ok).toBe(true);
    expect(
      releaseUltraPlanBatchActiveRunLease(
        paths,
        cwd,
        { runId: lease.runId, ownerSessionId: lease.ownerSessionId },
        "paused",
        "2026-04-21T12:10:00.000Z",
      ).ok,
    ).toBe(true);
    expect(loadUltraPlanBatchActiveRunLease(paths, cwd)).toEqual({
      ok: true,
      value: {
        runId: lease.runId,
        ownerSessionId: null,
        leaseAcquiredAt: null,
        leaseExpiresAt: null,
        updatedAt: "2026-04-21T12:10:00.000Z",
      },
    });

    expect(saveUltraPlanBatchActiveRunLease(paths, cwd, lease).ok).toBe(true);
    expect(
      releaseUltraPlanBatchActiveRunLease(
        paths,
        cwd,
        { runId: lease.runId, ownerSessionId: lease.ownerSessionId },
        "blocked",
        "2026-04-21T12:11:00.000Z",
      ).ok,
    ).toBe(true);
    expect(loadUltraPlanBatchActiveRunLease(paths, cwd)).toEqual({
      ok: true,
      value: {
        runId: lease.runId,
        ownerSessionId: null,
        leaseAcquiredAt: null,
        leaseExpiresAt: null,
        updatedAt: "2026-04-21T12:11:00.000Z",
      },
    });
  });

  test("refuses release when the persisted lease owner does not match", () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    const lease = makeUltraPlanBatchActiveRunLease();

    expect(saveUltraPlanBatchActiveRunLease(paths, cwd, lease).ok).toBe(true);
    expect(
      releaseUltraPlanBatchActiveRunLease(
        paths,
        cwd,
        { runId: lease.runId, ownerSessionId: "wrong-owner" },
        "paused",
        "2026-04-21T12:12:00.000Z",
      ),
    ).toMatchObject({ ok: false, error: { kind: "validation-error" } });
    expect(loadUltraPlanBatchActiveRunLease(paths, cwd)).toEqual({ ok: true, value: lease });
  });

  test("clears active-run.json only after complete or abandoned", () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    const lease = makeUltraPlanBatchActiveRunLease();
    const activeRunPath = getUltraplanActiveBatchRunPath(paths, cwd);

    expect(saveUltraPlanBatchActiveRunLease(paths, cwd, lease).ok).toBe(true);
    expect(
      releaseUltraPlanBatchActiveRunLease(
        paths,
        cwd,
        { runId: lease.runId, ownerSessionId: lease.ownerSessionId },
        "complete",
        "2026-04-21T12:20:00.000Z",
      ).ok,
    ).toBe(true);
    expect(fs.existsSync(activeRunPath)).toBe(false);
    expect(loadUltraPlanBatchActiveRunLease(paths, cwd)).toEqual({ ok: true, value: null });

    expect(saveUltraPlanBatchActiveRunLease(paths, cwd, lease).ok).toBe(true);
    expect(
      releaseUltraPlanBatchActiveRunLease(
        paths,
        cwd,
        { runId: lease.runId, ownerSessionId: lease.ownerSessionId },
        "abandoned",
        "2026-04-21T12:21:00.000Z",
      ).ok,
    ).toBe(true);
    expect(fs.existsSync(activeRunPath)).toBe(false);
    expect(loadUltraPlanBatchActiveRunLease(paths, cwd)).toEqual({ ok: true, value: null });
  });

  test("rejects semantically invalid active-run lease combinations", () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    const lease = makeUltraPlanBatchActiveRunLease();

    expect(saveUltraPlanBatchActiveRunLease(paths, cwd, {
      ...lease,
      ownerSessionId: "broken-owner",
      leaseAcquiredAt: null,
      leaseExpiresAt: null,
    })).toMatchObject({ ok: false, error: { kind: "validation-error" } });
    expect(saveUltraPlanBatchActiveRunLease(paths, cwd, {
      ...lease,
      leaseExpiresAt: "2026-04-21T11:59:00.000Z",
    })).toMatchObject({ ok: false, error: { kind: "validation-error" } });
  });

  test("uses run.json as the source of truth for the active batch state", () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    const run = makeUltraPlanBatchRun({ state: "complete" });
    const lease = makeUltraPlanBatchActiveRunLease({ runId: run.runId });

    expect(saveUltraPlanBatchRun(paths, cwd, run).ok).toBe(true);
    expect(saveUltraPlanBatchActiveRunLease(paths, cwd, lease).ok).toBe(true);
    expect(loadUltraPlanActiveBatchRun(paths, cwd)).toEqual({ ok: true, value: run });
  });

  test("fails closed on invalid active-run.json instead of overwriting exclusivity state", () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    const lease = makeUltraPlanBatchActiveRunLease();
    const activeRunPath = getUltraplanActiveBatchRunPath(paths, cwd);

    fs.mkdirSync(path.dirname(activeRunPath), { recursive: true });
    fs.writeFileSync(activeRunPath, "{not-json");
    expect(loadUltraPlanBatchActiveRunLease(paths, cwd)).toMatchObject({
      ok: false,
      error: { kind: "invalid-json" },
    });

    fs.writeFileSync(activeRunPath, JSON.stringify({ runId: lease.runId }));
    expect(loadUltraPlanBatchActiveRunLease(paths, cwd)).toMatchObject({
      ok: false,
      error: { kind: "validation-error" },
    });
    expect(acquireUltraPlanBatchActiveRunLease(paths, cwd, lease)).toMatchObject({
      ok: false,
      error: { kind: "validation-error" },
    });
  });

  test("fails closed on invalid run.json schema and duplicate persisted identifiers", () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    const run = makeUltraPlanBatchRun();
    const runPath = getUltraplanBatchRunPath(paths, cwd, run.runId);

    fs.mkdirSync(path.dirname(runPath), { recursive: true });
    fs.writeFileSync(runPath, JSON.stringify({ runId: run.runId }));
    expect(loadUltraPlanBatchRun(paths, cwd, run.runId)).toMatchObject({
      ok: false,
      error: { kind: "validation-error" },
    });

    const duplicateNodeIds = makeUltraPlanBatchRun({
      runId: "batch-dup-node",
      nodes: [
        makeUltraPlanBatchNode({ nodeId: "node-1", sessionId: "up-1" }),
        makeUltraPlanBatchNode({ nodeId: "node-1", sessionId: "up-2" }),
      ],
    });
    expect(saveUltraPlanBatchRun(paths, cwd, duplicateNodeIds)).toMatchObject({
      ok: false,
      error: { kind: "validation-error" },
    });

    const duplicateSessionIds = makeUltraPlanBatchRun({
      runId: "batch-dup-session",
      nodes: [
        makeUltraPlanBatchNode({ nodeId: "node-1", sessionId: "up-1" }),
        makeUltraPlanBatchNode({ nodeId: "node-2", sessionId: "up-1" }),
      ],
    });
    expect(saveUltraPlanBatchRun(paths, cwd, duplicateSessionIds)).toMatchObject({
      ok: false,
      error: { kind: "validation-error" },
    });
    const malformedWaves = makeUltraPlanBatchRun({
      runId: "batch-bad-waves",
      nodes: [
        makeUltraPlanBatchNode({ nodeId: "node-1", sessionId: "up-1", waveIndex: 0 }),
        makeUltraPlanBatchNode({ nodeId: "node-2", sessionId: "up-2", waveIndex: 1 }),
      ],
      waves: [
        { waveIndex: 0, sessionIds: ["up-1", "up-2"] },
        { waveIndex: 1, sessionIds: [] },
      ],
    });
    expect(saveUltraPlanBatchRun(paths, cwd, malformedWaves)).toMatchObject({
      ok: false,
      error: { kind: "validation-error" },
    });

  });

  test("clears active-run.json on explicit clear", () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    const lease = makeUltraPlanBatchActiveRunLease();

    expect(saveUltraPlanBatchActiveRunLease(paths, cwd, lease).ok).toBe(true);
    expect(clearUltraPlanBatchActiveRunLease(paths, cwd).ok).toBe(true);
    expect(loadUltraPlanBatchActiveRunLease(paths, cwd)).toEqual({ ok: true, value: null });
  });
});
