import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createTestPaths, createTestRepo, makeUltraPlanRuntimeTracker } from "../fixtures.js";
import {
  getUltraplanHooksLogPath,
  getUltraplanRuntimeTrackerPath,
} from "../../../src/ultraplan/project-paths.js";
import {
  appendHookLog,
  clearPendingMutation,
  loadTracker,
  reconcilePendingMutationAgainstManifest,
  saveTrackerAtomic,
  stagePendingMutation,
} from "../../../src/ultraplan/runtime/tracker-storage.js";
import type {
  UltraPlanAttemptRecord,
  UltraPlanHookObservation,
  UltraPlanMutationPlan,
  UltraPlanPendingMutation,
  UltraPlanRuntimeTracker,
} from "../../../src/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-ultraplan-tracker-"));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeObservation(fingerprint: string, overrides: Partial<UltraPlanHookObservation> = {}): UltraPlanHookObservation {
  return {
    sessionId: "up-123",
    hookEvent: "tool_result",
    actorKind: "slot",
    attemptId: "att-1",
    attemptKey: "k/red",
    sourceAgent: "sub-agent",
    occurredAt: "2026-04-19T12:00:01.000Z",
    causationId: "turn-1",
    fingerprint,
    target: null,
    correlationFailure: null,
    payloadSummary: "red failure",
    ...overrides,
  };
}

function makeAttempt(fingerprints: string[] = []): UltraPlanAttemptRecord {
  return {
    attemptId: "att-1",
    attemptKey: "k/red",
    launchContext: {
      attemptId: "att-1",
      attemptKey: "k/red",
      sourceAgent: "sub-agent",
      launchedAt: "2026-04-19T12:00:00.000Z",
    },
    cursorSnapshot: null,
    observations: fingerprints.map((fp) => makeObservation(fp)),
    proofCandidates: [],
    blockerCandidates: [],
    outcome: null,
    startedAt: "2026-04-19T12:00:00.000Z",
    finalizedAt: null,
  };
}

function noopPlan(): UltraPlanMutationPlan {
  return {
    kind: "noop",
    rationale: "test noop",
    appendObservationFingerprint: null,
    scenarioStatusUpdate: null,
    reviewStatusUpdate: null,
    blockerUpdate: null,
    cursorUpdate: null,
    sessionStateUpdate: null,
    trackerAttemptFinalization: null,
    recomputeProgress: false,
    repairActions: [],
    notes: [],
  };
}

describe("tracker storage round-trip", () => {
  test("loading a missing tracker returns a missing-kind failure", () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    const result = loadTracker(paths, cwd, "up-absent");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("missing");
    }
  });

  test("save+reload round-trips a fresh tracker", () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    const tracker = makeUltraPlanRuntimeTracker({ sessionId: "up-rt" });
    const saved = saveTrackerAtomic(paths, cwd, "up-rt", tracker);
    expect(saved.ok).toBe(true);

    const loaded = loadTracker(paths, cwd, "up-rt");
    expect(loaded).toMatchObject({ ok: true, value: tracker });
  });

  test("saving a malformed tracker is rejected with a validation-error", () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    const bad = { ...makeUltraPlanRuntimeTracker(), version: 99 } as any;
    const result = saveTrackerAtomic(paths, cwd, "up-bad", bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation-error");
    }
  });
});

describe("tracker dedupe persistence", () => {
  test("appliedFingerprints persists through reload and de-dupes on re-save", () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    const tracker = makeUltraPlanRuntimeTracker({
      sessionId: "up-dedupe",
      appliedFingerprints: ["fp-1"],
    });
    const saved = saveTrackerAtomic(paths, cwd, "up-dedupe", tracker);
    expect(saved.ok).toBe(true);

    const loaded = loadTracker(paths, cwd, "up-dedupe");
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.appliedFingerprints).toEqual(["fp-1"]);
    }

    // Re-save with a duplicate entry must produce a de-duplicated, single-element array on disk.
    const withDuplicate = {
      ...(loaded.ok ? loaded.value : tracker),
      appliedFingerprints: ["fp-1", "fp-1"],
    } as UltraPlanRuntimeTracker;
    const second = saveTrackerAtomic(paths, cwd, "up-dedupe", withDuplicate);
    expect(second.ok).toBe(true);
    const reloaded = loadTracker(paths, cwd, "up-dedupe");
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) {
      expect(reloaded.value.appliedFingerprints).toEqual(["fp-1"]);
    }
  });
});

describe("hooks-log append-only behavior", () => {
  test("appending observations preserves insertion order", () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    const sessionId = "up-log";
    appendHookLog(paths, cwd, sessionId, makeObservation("fp-a"));
    appendHookLog(paths, cwd, sessionId, makeObservation("fp-b"));
    appendHookLog(paths, cwd, sessionId, makeObservation("fp-c"));

    const contents = fs.readFileSync(getUltraplanHooksLogPath(paths, cwd, sessionId), "utf8");
    const lines = contents.trim().split("\n");
    expect(lines.length).toBe(3);
    const fingerprints = lines.map((line) => JSON.parse(line).fingerprint);
    expect(fingerprints).toEqual(["fp-a", "fp-b", "fp-c"]);
  });

  test("appending a duplicate fingerprint after that fingerprint has been applied is a persisted no-op", () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    const sessionId = "up-dedupe-log";
    // Mark fp-x as already applied in the tracker.
    saveTrackerAtomic(paths, cwd, sessionId, makeUltraPlanRuntimeTracker({
      sessionId,
      appliedFingerprints: ["fp-x"],
    }));
    appendHookLog(paths, cwd, sessionId, makeObservation("fp-x"));
    appendHookLog(paths, cwd, sessionId, makeObservation("fp-x"));

    const logPath = getUltraplanHooksLogPath(paths, cwd, sessionId);
    const contents = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
    const lines = contents.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(0);
  });
});

describe("pendingMutation durability and reconciliation", () => {
  function makePending(plan: UltraPlanMutationPlan = noopPlan()): UltraPlanPendingMutation {
    return {
      attemptId: "att-1",
      mutationPlan: plan,
      expectedManifestFingerprint: "sha256:expected",
      stagedAt: "2026-04-19T12:00:01.500Z",
    };
  }

  test("stagePendingMutation writes tracker with pendingMutation set and clearPendingMutation clears it", () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    const sessionId = "up-durability";
    saveTrackerAtomic(paths, cwd, sessionId, makeUltraPlanRuntimeTracker({ sessionId }));

    const staged = stagePendingMutation(paths, cwd, sessionId, makePending());
    expect(staged.ok).toBe(true);
    const withPending = loadTracker(paths, cwd, sessionId);
    expect(withPending.ok && withPending.value.pendingMutation).not.toBeNull();

    const cleared = clearPendingMutation(paths, cwd, sessionId);
    expect(cleared.ok).toBe(true);
    const afterClear = loadTracker(paths, cwd, sessionId);
    expect(afterClear.ok && afterClear.value.pendingMutation).toBeNull();
  });

  test("reconciliation commits the pending mutation when the manifest already matches the staged fingerprint", () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    const sessionId = "up-reconcile-match";
    saveTrackerAtomic(paths, cwd, sessionId, makeUltraPlanRuntimeTracker({ sessionId }));
    stagePendingMutation(paths, cwd, sessionId, makePending());

    const result = reconcilePendingMutationAgainstManifest(paths, cwd, sessionId, "sha256:expected");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("committed");
    }
    const reloaded = loadTracker(paths, cwd, sessionId);
    expect(reloaded.ok && reloaded.value.pendingMutation).toBeNull();
  });

  test("reconciliation returns 'replay-needed' when the manifest has not been written yet", () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    const sessionId = "up-reconcile-mismatch";
    saveTrackerAtomic(paths, cwd, sessionId, makeUltraPlanRuntimeTracker({ sessionId }));
    stagePendingMutation(paths, cwd, sessionId, makePending());

    const result = reconcilePendingMutationAgainstManifest(paths, cwd, sessionId, "sha256:different");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("replay-needed");
    }
    // Reconciliation leaves the pending mutation in place when it cannot commit.
    const reloaded = loadTracker(paths, cwd, sessionId);
    expect(reloaded.ok && reloaded.value.pendingMutation).not.toBeNull();
  });

  test("reconciliation is a no-op when no pendingMutation exists", () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    const sessionId = "up-reconcile-none";
    saveTrackerAtomic(paths, cwd, sessionId, makeUltraPlanRuntimeTracker({ sessionId }));

    const result = reconcilePendingMutationAgainstManifest(paths, cwd, sessionId, "any");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("no-pending");
    }
  });
});

describe("interrupted-attempt tracker reload behavior", () => {
  test("saving a tracker with an interrupted active attempt moves it to the finalized ledger with activeAttempt null on reload", () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    const sessionId = "up-interrupted";
    const interrupted: UltraPlanAttemptRecord = {
      ...makeAttempt(),
      outcome: "interrupted",
      finalizedAt: "2026-04-19T12:05:00.000Z",
    };
    // The caller moved the interrupted attempt to finalized before persisting; the tracker must
    // preserve that on reload.
    const tracker: UltraPlanRuntimeTracker = {
      ...makeUltraPlanRuntimeTracker({ sessionId }),
      activeAttempt: null,
      finalizedAttempts: [interrupted],
    };
    const saved = saveTrackerAtomic(paths, cwd, sessionId, tracker);
    expect(saved.ok).toBe(true);

    const reloaded = loadTracker(paths, cwd, sessionId);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) {
      expect(reloaded.value.activeAttempt).toBeNull();
      expect(reloaded.value.finalizedAttempts.length).toBe(1);
      expect(reloaded.value.finalizedAttempts[0].outcome).toBe("interrupted");
    }
  });
});
