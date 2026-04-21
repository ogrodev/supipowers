import { describe, expect, test } from "bun:test";
import { isUltraPlanBlocker } from "../../../src/ultraplan/contracts.js";
import {
  buildConflictingEvidenceBlocker,
  buildCorrelationAmbiguousBlocker,
  buildInterruptedAttemptBlocker,
  buildMigrationConflictBlocker,
  buildMigrationUnsafeBlocker,
  buildPersistenceFailureBlocker,
  buildProofInvalidBlocker,
  buildProofMissingBlocker,
  buildUnsafeRepairRequiredBlocker,
} from "../../../src/ultraplan/runtime/blockers.js";

const AFFECTED_SCENARIO = {
  stack: "frontend" as const,
  domainId: "auth",
  level: "unit" as const,
  scenarioId: "scenario-login-form-renders",
};

const AFFECTED_SESSION = {
  stack: null,
  domainId: null,
  level: null,
  scenarioId: null,
};

describe("ultraplan runtime blocker factories", () => {
  test("correlation-ambiguous blocker has manual recovery and is non-retryable by default", () => {
    const blocker = buildCorrelationAmbiguousBlocker({
      detectedAt: "2026-04-19T12:00:00.000Z",
      affected: AFFECTED_SESSION,
      reason: "multiple plausible attempts for slot-backed tool_result",
    });
    expect(isUltraPlanBlocker(blocker)).toBe(true);
    expect(blocker.code).toBe("correlation-ambiguous");
    expect(blocker.scope).toBe("session");
    expect(blocker.recoveryMode).toBe("manual");
    expect(blocker.retryable).toBe(false);
    expect(blocker.recoverable).toBe(true);
  });

  test("proof-missing blocker has retry recovery and is retryable", () => {
    const blocker = buildProofMissingBlocker({
      detectedAt: "2026-04-19T12:00:00.000Z",
      scope: "scenario",
      affected: AFFECTED_SCENARIO,
      expectedPhase: "red",
    });
    expect(isUltraPlanBlocker(blocker)).toBe(true);
    expect(blocker.code).toBe("proof-missing");
    expect(blocker.recoveryMode).toBe("retry");
    expect(blocker.retryable).toBe(true);
  });

  test("proof-invalid blocker has retry recovery", () => {
    const blocker = buildProofInvalidBlocker({
      detectedAt: "2026-04-19T12:00:00.000Z",
      scope: "scenario",
      affected: AFFECTED_SCENARIO,
      reason: "wrong phase: expected red, received green",
    });
    expect(isUltraPlanBlocker(blocker)).toBe(true);
    expect(blocker.code).toBe("proof-invalid");
    expect(blocker.recoveryMode).toBe("retry");
    expect(blocker.retryable).toBe(true);
  });

  test("conflicting-evidence blocker is manual and non-retryable (fail closed)", () => {
    const blocker = buildConflictingEvidenceBlocker({
      detectedAt: "2026-04-19T12:00:00.000Z",
      scope: "scenario",
      affected: AFFECTED_SCENARIO,
      reason: "valid proof and terminal blocker observed in same attempt",
    });
    expect(isUltraPlanBlocker(blocker)).toBe(true);
    expect(blocker.code).toBe("conflicting-evidence");
    expect(blocker.recoveryMode).toBe("manual");
    expect(blocker.retryable).toBe(false);
  });

  test("interrupted-attempt blocker is retryable with retry recovery", () => {
    const blocker = buildInterruptedAttemptBlocker({
      detectedAt: "2026-04-19T12:00:00.000Z",
      scope: "scenario",
      affected: AFFECTED_SCENARIO,
      attemptId: "att-001",
    });
    expect(isUltraPlanBlocker(blocker)).toBe(true);
    expect(blocker.code).toBe("interrupted-attempt");
    expect(blocker.recoveryMode).toBe("retry");
    expect(blocker.retryable).toBe(true);
    expect(blocker.details).toMatchObject({ attemptId: "att-001" });
  });

  test("persistence-failure blocker is manual with helpful next action", () => {
    const blocker = buildPersistenceFailureBlocker({
      detectedAt: "2026-04-19T12:00:00.000Z",
      scope: "session",
      affected: AFFECTED_SESSION,
      reason: "tracker write failed validation",
    });
    expect(isUltraPlanBlocker(blocker)).toBe(true);
    expect(blocker.code).toBe("persistence-failure");
    expect(blocker.recoveryMode).toBe("manual");
    expect(blocker.retryable).toBe(false);
    expect(blocker.nextAction.length).toBeGreaterThan(0);
  });

  test("unsafe-repair-required blocker is manual", () => {
    const blocker = buildUnsafeRepairRequiredBlocker({
      detectedAt: "2026-04-19T12:00:00.000Z",
      scope: "session",
      affected: AFFECTED_SESSION,
      reason: "cursor references a terminal scenario with ambiguous history",
    });
    expect(isUltraPlanBlocker(blocker)).toBe(true);
    expect(blocker.code).toBe("unsafe-repair-required");
    expect(blocker.recoveryMode).toBe("manual");
    expect(blocker.retryable).toBe(false);
  });

  test("migration-unsafe blocker is manual and session-scope", () => {
    const blocker = buildMigrationUnsafeBlocker({
      detectedAt: "2026-04-20T12:00:00.000Z",
      legacyPath: "/abs/repo/.omp/supipowers/ultraplans/up-1",
      reason: "legacy manifest failed schema validation",
    });
    expect(isUltraPlanBlocker(blocker)).toBe(true);
    expect(blocker.code).toBe("migration-unsafe");
    expect(blocker.scope).toBe("session");
    expect(blocker.recoveryMode).toBe("manual");
    expect(blocker.retryable).toBe(false);
    expect(blocker.details).toMatchObject({ legacyPath: "/abs/repo/.omp/supipowers/ultraplans/up-1" });
  });

  test("migration-conflict blocker is manual and session-scope", () => {
    const blocker = buildMigrationConflictBlocker({
      detectedAt: "2026-04-20T12:00:00.000Z",
      legacyPath: "/abs/repo/.omp/supipowers/ultraplans/up-1",
      globalPath: "/abs/home/.omp/supipowers/projects/slug/ultraplans/up-1",
      reason: "repo-local and global sessions differ on updatedAt",
    });
    expect(isUltraPlanBlocker(blocker)).toBe(true);
    expect(blocker.code).toBe("migration-conflict");
    expect(blocker.scope).toBe("session");
    expect(blocker.recoveryMode).toBe("manual");
    expect(blocker.retryable).toBe(false);
    expect(blocker.details).toMatchObject({
      legacyPath: "/abs/repo/.omp/supipowers/ultraplans/up-1",
      globalPath: "/abs/home/.omp/supipowers/projects/slug/ultraplans/up-1",
    });
  });
});
