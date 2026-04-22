import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyUltraPlanMutation } from "../../../src/ultraplan/runtime/apply-mutation.js";
import {
  getUltraplanDomainReviewPath,
  getUltraplanExecutionLogPath,
  getUltraplanStackReviewPath,
} from "../../../src/ultraplan/project-paths.js";
import { loadTracker } from "../../../src/ultraplan/runtime/tracker-storage.js";
import {
  loadUltraPlanAuthoredArtifact,
  loadUltraPlanManifest,
  saveUltraPlanAuthoredArtifact,
  saveUltraPlanManifest,
} from "../../../src/ultraplan/storage.js";
import type { UltraPlanCursor } from "../../../src/types.js";
import {
  createTestPaths,
  createTestRepo,
  makeUltraPlanAuthored,
  makeUltraPlanHookObservation,
  makeUltraPlanManifest,
  makeUltraPlanMutationPlan,
  makeUltraPlanScenario,
  makeUltraPlanStack,
} from "../fixtures.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-ultraplan-apply-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeCursor(overrides: Partial<UltraPlanCursor> = {}): UltraPlanCursor {
  return {
    targetType: "scenario",
    stack: "frontend",
    domainId: "auth",
    level: "unit",
    scenarioId: "scenario-login-form-renders",
    phase: "red",
    status: "red-running",
    summary: "frontend / auth / unit / Login form renders",
    ...overrides,
  };
}

function phaseForStatus(status: string): UltraPlanCursor["phase"] {
  switch (status) {
    case "planned":
    case "red-running":
      return "red";
    case "red-proved":
    case "green-running":
      return "green";
    case "in-review":
      return "review";
    case "blocked":
      return "waiting";
    default:
      return "complete";
  }
}

function buildSingleScenarioSession(status: Parameters<typeof makeUltraPlanScenario>[2]) {
  const scenario = makeUltraPlanScenario(
    "scenario-login-form-renders",
    "Login form renders",
    status,
    "unit",
    { stack: "frontend", domainId: "auth" },
  );
  const authored = makeUltraPlanAuthored({
    stacks: [
      makeUltraPlanStack({
        domains: [{
          id: "auth",
          name: "Authentication",
          unit: [scenario],
          integration: [],
          e2e: [],
          review: { enabled: true, status: "pending" },
          progress: { total: 1, terminal: status === "green-proved" ? 1 : 0, blocked: status === "blocked" ? 1 : 0 },
        }],
        progress: { total: 1, terminal: status === "green-proved" ? 1 : 0, blocked: status === "blocked" ? 1 : 0 },
      }),
    ],
  });
  const manifest = makeUltraPlanManifest({
    sessionId: authored.sessionId,
    cursor: makeCursor({ status, phase: phaseForStatus(status) }),
    state: status === "red-running" ? "running" : "ready",
    progress: { total: 1, terminal: status === "green-proved" ? 1 : 0, blocked: status === "blocked" ? 1 : 0 },
  });

  return { authored, manifest };
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function seedSession(paths: ReturnType<typeof createTestPaths>, cwd: string, authored: ReturnType<typeof makeUltraPlanAuthored>, manifest = makeUltraPlanManifest({ sessionId: authored.sessionId })) {
  const authoredSave = saveUltraPlanAuthoredArtifact(paths, cwd, authored.sessionId, authored);
  expect(authoredSave.ok).toBe(true);
  const manifestSave = saveUltraPlanManifest(paths, cwd, authored.sessionId, manifest);
  expect(manifestSave.ok).toBe(true);
}

describe("ultraplan apply mutation", () => {
  test("start-attempt writes tracker state for the active attempt", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const { authored, manifest } = buildSingleScenarioSession("planned");
    seedSession(paths, cwd, authored, manifest);

    const observation = makeUltraPlanHookObservation({
      hookEvent: "before_agent_start",
      fingerprint: "fp-start",
      occurredAt: "2026-04-19T12:00:00.000Z",
      target: { ...makeUltraPlanHookObservation().target!, resolvedSlot: "frontend-executor" },
    });

    applyUltraPlanMutation({
      platform: { paths } as any,
      cwd,
      sessionId: observation.sessionId,
      observation,
      mutationPlan: makeUltraPlanMutationPlan({
        kind: "start-attempt",
        appendObservationFingerprint: observation.fingerprint,
        cursorUpdate: makeCursor(),
      }),
    });

    const trackerResult = loadTracker(paths, cwd, observation.sessionId);
    expect(trackerResult.ok).toBe(true);
    if (!trackerResult.ok) return;
    expect(trackerResult.value.activeAttempt?.attemptId === observation.attemptId).toBe(true);
    expect(trackerResult.value.activeAttempt?.cursorSnapshot).toEqual(makeCursor());
    expect(trackerResult.value.appliedFingerprints).toEqual(["fp-start"]);
  });

  test("non-noop mutation appends one execution-log entry", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const observation = makeUltraPlanHookObservation({ fingerprint: "fp-stage" });

    applyUltraPlanMutation({
      platform: { paths } as any,
      cwd,
      sessionId: observation.sessionId,
      observation,
      mutationPlan: makeUltraPlanMutationPlan({
        kind: "stage-observation",
        appendObservationFingerprint: observation.fingerprint,
      }),
    });

    const logPath = getUltraplanExecutionLogPath(paths, cwd, observation.sessionId);
    const entries = fs.readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));

    expect(entries).toHaveLength(1);
    expect(entries[0].mutation.kind).toBe("stage-observation");
    expect(entries[0].observationFingerprint).toBe("fp-stage");
  });

  test("replayed observations do not duplicate tracker or execution-log effects", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const observation = makeUltraPlanHookObservation({ fingerprint: "fp-replay" });
    const mutationPlan = makeUltraPlanMutationPlan({
      kind: "stage-observation",
      appendObservationFingerprint: observation.fingerprint,
    });

    applyUltraPlanMutation({
      platform: { paths } as any,
      cwd,
      sessionId: observation.sessionId,
      observation,
      mutationPlan,
    });
    applyUltraPlanMutation({
      platform: { paths } as any,
      cwd,
      sessionId: observation.sessionId,
      observation,
      mutationPlan,
    });

    const trackerResult = loadTracker(paths, cwd, observation.sessionId);
    expect(trackerResult.ok).toBe(true);
    if (!trackerResult.ok) return;
    expect(trackerResult.value.appliedFingerprints).toEqual(["fp-replay"]);

    const logPath = getUltraplanExecutionLogPath(paths, cwd, observation.sessionId);
    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
  });

  test("scenarioStatusUpdate appends proof to the correct scenario and recomputes the cursor", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const { authored, manifest } = buildSingleScenarioSession("red-running");
    seedSession(paths, cwd, authored, manifest);

    const observation = makeUltraPlanHookObservation({
      fingerprint: "fp-red-proof",
      occurredAt: "2026-04-19T12:05:00.000Z",
    });

    applyUltraPlanMutation({
      platform: { paths } as any,
      cwd,
      sessionId: authored.sessionId,
      observation,
      mutationPlan: makeUltraPlanMutationPlan({
        kind: "advance",
        appendObservationFingerprint: observation.fingerprint,
        scenarioStatusUpdate: {
          stack: "frontend",
          domainId: "auth",
          level: "unit",
          scenarioId: "scenario-login-form-renders",
          nextStatus: "red-proved",
          appendProof: {
            type: "test",
            phase: "red",
            recordedAt: observation.occurredAt,
            actor: "frontend-tester",
            evidence: { summary: "Red phase fails as expected" },
            artifactRef: "artifact://red-proof",
          },
        },
      }),
    });

    const authoredResult = loadUltraPlanAuthoredArtifact(paths, cwd, authored.sessionId);
    expect(authoredResult.ok).toBe(true);
    if (!authoredResult.ok) return;
    const scenario = authoredResult.value.stacks[0].domains[0].unit[0];
    expect(scenario.status).toBe("red-proved");
    expect(scenario.proofs.at(-1)?.artifactRef === "artifact://red-proof").toBe(true);

    const manifestResult = loadUltraPlanManifest(paths, cwd, authored.sessionId);
    expect(manifestResult.ok).toBe(true);
    if (!manifestResult.ok) return;
    expect(manifestResult.value.cursor?.phase).toBe("green");

    const trackerResult = loadTracker(paths, cwd, authored.sessionId);
    expect(trackerResult.ok).toBe(true);
    if (!trackerResult.ok) return;
    expect(trackerResult.value.pendingMutation).toBeNull();
  });

  test("rejects an invalid passed domain review reference before updating the manifest", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const { authored, manifest } = buildSingleScenarioSession("green-proved");
    seedSession(paths, cwd, authored, manifest);

    const observation = makeUltraPlanHookObservation({ fingerprint: "fp-domain-review" });

    expect(() => applyUltraPlanMutation({
      platform: { paths } as any,
      cwd,
      sessionId: authored.sessionId,
      observation,
      mutationPlan: makeUltraPlanMutationPlan({
        kind: "advance",
        appendObservationFingerprint: observation.fingerprint,
        reviewStatusUpdate: {
          type: "domain",
          stack: "frontend",
          domainId: "auth",
          nextStatus: "passed",
          artifactRef: "/tmp/not-the-canonical-review-path.json",
        },
      }),
    })).toThrow();

    const manifestResult = loadUltraPlanManifest(paths, cwd, authored.sessionId);
    expect(manifestResult.ok).toBe(true);
    if (!manifestResult.ok) return;
    expect(manifestResult.value.reviews).toEqual([]);
  });

  test("rejects an invalid passed stack review reference before updating the manifest", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const { authored, manifest } = buildSingleScenarioSession("green-proved");
    seedSession(paths, cwd, authored, manifest);

    const observation = makeUltraPlanHookObservation({ fingerprint: "fp-stack-review" });

    expect(() => applyUltraPlanMutation({
      platform: { paths } as any,
      cwd,
      sessionId: authored.sessionId,
      observation,
      mutationPlan: makeUltraPlanMutationPlan({
        kind: "advance",
        appendObservationFingerprint: observation.fingerprint,
        reviewStatusUpdate: {
          type: "stack",
          stack: "frontend",
          domainId: null,
          nextStatus: "passed",
          artifactRef: "/tmp/not-the-canonical-stack-review-path.json",
        },
      }),
    })).toThrow();

    const manifestResult = loadUltraPlanManifest(paths, cwd, authored.sessionId);
    expect(manifestResult.ok).toBe(true);
    if (!manifestResult.ok) return;
    expect(manifestResult.value.reviews).toEqual([]);
  });

  test("blocker updates preserve and clear manifest.blocker truthfully", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const { authored, manifest } = buildSingleScenarioSession("red-running");
    seedSession(paths, cwd, authored, manifest);

    const setObservation = makeUltraPlanHookObservation({ fingerprint: "fp-block-set", occurredAt: "2026-04-19T12:10:00.000Z" });
    applyUltraPlanMutation({
      platform: { paths } as any,
      cwd,
      sessionId: authored.sessionId,
      observation: setObservation,
      mutationPlan: makeUltraPlanMutationPlan({
        kind: "block",
        appendObservationFingerprint: setObservation.fingerprint,
        blockerUpdate: {
          scope: "scenario",
          nextValue: {
            code: "proof-missing",
            message: "Need the red-phase failure proof",
            scope: "scenario",
            affected: { stack: "frontend", domainId: "auth", level: "unit", scenarioId: "scenario-login-form-renders" },
            recoverable: true,
            recoveryMode: "retry",
            nextAction: "Retry the failing proof",
            retryable: true,
            detectedAt: setObservation.occurredAt,
          },
          clearedByObservationFingerprint: null,
        },
      }),
    });

    let manifestResult = loadUltraPlanManifest(paths, cwd, authored.sessionId);
    expect(manifestResult.ok).toBe(true);
    if (!manifestResult.ok) return;
    expect(manifestResult.value.blocker?.code).toBe("proof-missing");

    const clearObservation = makeUltraPlanHookObservation({ fingerprint: "fp-block-clear", occurredAt: "2026-04-19T12:12:00.000Z" });
    applyUltraPlanMutation({
      platform: { paths } as any,
      cwd,
      sessionId: authored.sessionId,
      observation: clearObservation,
      mutationPlan: makeUltraPlanMutationPlan({
        kind: "repair",
        appendObservationFingerprint: clearObservation.fingerprint,
        blockerUpdate: {
          scope: "scenario",
          nextValue: null,
          clearedByObservationFingerprint: setObservation.fingerprint,
        },
      }),
    });

    manifestResult = loadUltraPlanManifest(paths, cwd, authored.sessionId);
    expect(manifestResult.ok).toBe(true);
    if (!manifestResult.ok) return;
    expect(manifestResult.value.blocker).toBeNull();
  });

  test("session completion updates manifest.state and cursor after the last review passes", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir);
    const { authored, manifest } = buildSingleScenarioSession("green-proved");
    const domainReviewPath = getUltraplanDomainReviewPath(paths, cwd, authored.sessionId, "frontend", "auth");
    const stackReviewPath = getUltraplanStackReviewPath(paths, cwd, authored.sessionId, "frontend");

    manifest.reviews = [{
      type: "domain",
      stack: "frontend",
      domainId: "auth",
      path: domainReviewPath,
      status: "passed",
    }];
    seedSession(paths, cwd, authored, manifest);

    writeJson(domainReviewPath, {
      stack: "frontend",
      domainId: "auth",
      reviewerSlot: "frontend-domain-reviewer",
      status: "passed",
      startedAt: "2026-04-19T12:00:00.000Z",
      completedAt: "2026-04-19T12:01:00.000Z",
      summary: "Domain review passed",
      artifactRef: domainReviewPath,
    });
    writeJson(stackReviewPath, {
      stack: "frontend",
      reviewerSlot: "frontend-stack-reviewer",
      status: "passed",
      startedAt: "2026-04-19T12:02:00.000Z",
      completedAt: "2026-04-19T12:03:00.000Z",
      summary: "Stack review passed",
      artifactRef: stackReviewPath,
    });

    const observation = makeUltraPlanHookObservation({ fingerprint: "fp-final-review" });
    applyUltraPlanMutation({
      platform: { paths } as any,
      cwd,
      sessionId: authored.sessionId,
      observation,
      mutationPlan: makeUltraPlanMutationPlan({
        kind: "complete",
        appendObservationFingerprint: observation.fingerprint,
        reviewStatusUpdate: {
          type: "stack",
          stack: "frontend",
          domainId: null,
          nextStatus: "passed",
          artifactRef: stackReviewPath,
        },
      }),
    });

    const manifestResult = loadUltraPlanManifest(paths, cwd, authored.sessionId);
    expect(manifestResult.ok).toBe(true);
    if (!manifestResult.ok) return;
    expect(manifestResult.value.state).toBe("complete");
    expect(manifestResult.value.cursor?.targetType).toBe("session");
    expect(manifestResult.value.cursor?.status).toBe("complete");
  });
});
