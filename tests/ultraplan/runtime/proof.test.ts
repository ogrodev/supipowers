import { describe, expect, test } from "bun:test";
import type {
  UltraPlanExecutionPhase,
  UltraPlanHookObservation,
  UltraPlanProofCandidateTarget,
} from "../../../src/types.js";
import {
  extractProofCandidate,
  validateReviewArtifactProof,
} from "../../../src/ultraplan/runtime/proof.js";

const SCENARIO_TARGET: UltraPlanProofCandidateTarget = {
  targetType: "scenario",
  stack: "frontend",
  domainId: "auth",
  level: "unit",
  scenarioId: "scenario-login-form-renders",
};

function makeObservation(overrides: Partial<UltraPlanHookObservation> = {}): UltraPlanHookObservation {
  return {
    sessionId: "up-123",
    hookEvent: "tool_result",
    actorKind: "slot",
    attemptId: "att-1",
    attemptKey: "frontend/auth/unit/scenario-login-form-renders/red",
    sourceAgent: "sub-agent",
    occurredAt: "2026-04-19T12:00:01.000Z",
    causationId: "turn-1",
    fingerprint: "obs-fp-1",
    target: {
      targetType: "scenario",
      stack: "frontend",
      domainId: "auth",
      level: "unit",
      scenarioId: "scenario-login-form-renders",
      phase: "red",
      resolvedSlot: "frontend-tester",
    },
    correlationFailure: null,
    payloadSummary: "bun test: red failed as expected",
    ...overrides,
  };
}

describe("extractProofCandidate", () => {
  test("extracts a red-phase proof from a tool_result that matches target and phase", () => {
    const obs = makeObservation();
    const result = extractProofCandidate({
      observation: obs,
      payload: {
        proof: {
          type: "test",
          phase: "red",
          evidence: { summary: "failing as expected", command: "bun test" },
          artifactRef: "artifact://red-1",
        },
      },
      expectedTarget: SCENARIO_TARGET,
      expectedPhase: "red",
    });
    expect(result.kind).toBe("proof");
    if (result.kind === "proof") {
      expect(result.proof.phase).toBe("red");
      expect(result.proof.type).toBe("test");
      expect(result.proof.target).toEqual(SCENARIO_TARGET);
      expect(result.proof.observationFingerprint).toBe(obs.fingerprint);
      expect(result.proof.fingerprint.length).toBeGreaterThan(0);
    }
  });

  test("rejects proof with a mismatched phase", () => {
    const result = extractProofCandidate({
      observation: makeObservation(),
      payload: {
        proof: {
          type: "test",
          phase: "green",
          evidence: { summary: "green passed" },
          artifactRef: "artifact://green-1",
        },
      },
      expectedTarget: SCENARIO_TARGET,
      expectedPhase: "red",
    });
    expect(result.kind).toBe("blocker-candidate");
    if (result.kind === "blocker-candidate") {
      expect(result.blocker.blocker.code).toBe("proof-invalid");
    }
  });

  test("rejects proof whose target does not match the expected target", () => {
    const result = extractProofCandidate({
      observation: makeObservation({
        target: {
          targetType: "scenario",
          stack: "backend",
          domainId: "billing",
          level: "unit",
          scenarioId: "scenario-other",
          phase: "red",
          resolvedSlot: null,
        },
      }),
      payload: {
        proof: {
          type: "test",
          phase: "red",
          evidence: { summary: "red failed" },
          artifactRef: "artifact://red-1",
        },
      },
      expectedTarget: SCENARIO_TARGET,
      expectedPhase: "red",
    });
    expect(result.kind).toBe("blocker-candidate");
    if (result.kind === "blocker-candidate") {
      expect(result.blocker.blocker.code).toBe("proof-invalid");
    }
  });

  test("returns proof-invalid blocker when payload.proof is unparseable", () => {
    const result = extractProofCandidate({
      observation: makeObservation(),
      payload: { proof: "not-a-proof-object" as any },
      expectedTarget: SCENARIO_TARGET,
      expectedPhase: "red",
    });
    expect(result.kind).toBe("blocker-candidate");
    if (result.kind === "blocker-candidate") {
      expect(result.blocker.blocker.code).toBe("proof-invalid");
    }
  });

  test("returns 'none' when no proof-shaped signal is present on the payload", () => {
    const result = extractProofCandidate({
      observation: makeObservation(),
      payload: { exitCode: 0 },
      expectedTarget: SCENARIO_TARGET,
      expectedPhase: "red",
    });
    expect(result.kind).toBe("none");
  });

  test("is idempotent: same observation + payload produces identical proof fingerprint", () => {
    const commonInput = {
      observation: makeObservation(),
      payload: {
        proof: {
          type: "test" as const,
          phase: "red" as const,
          evidence: { summary: "red failed", command: "bun test" },
          artifactRef: "artifact://red-1",
        },
      },
      expectedTarget: SCENARIO_TARGET,
      expectedPhase: "red" as UltraPlanExecutionPhase,
    };
    const a = extractProofCandidate(commonInput);
    const b = extractProofCandidate(commonInput);
    expect(a.kind).toBe("proof");
    expect(b.kind).toBe("proof");
    if (a.kind === "proof" && b.kind === "proof") {
      expect(a.proof.fingerprint).toBe(b.proof.fingerprint);
    }
  });
});

describe("validateReviewArtifactProof", () => {
  test("requires the review artifact to live at its canonical path", () => {
    const result = validateReviewArtifactProof({
      reviewType: "domain",
      stack: "frontend",
      domainId: "auth",
      expectedCanonicalPath: "/abs/.../review/frontend/domains/auth.json",
      observedArtifactRef: "/abs/.../review/frontend/domains/other.json",
      artifact: { stack: "frontend", domainId: "auth", status: "passed" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/canonical path/i);
  });

  test("requires the artifact to match the review's target and be status=passed", () => {
    const result = validateReviewArtifactProof({
      reviewType: "domain",
      stack: "frontend",
      domainId: "auth",
      expectedCanonicalPath: "/abs/.../review/frontend/domains/auth.json",
      observedArtifactRef: "/abs/.../review/frontend/domains/auth.json",
      artifact: { stack: "frontend", domainId: "auth", status: "running" },
    });
    expect(result.ok).toBe(false);
  });

  test("accepts a domain review artifact that matches canonical path and is passed", () => {
    const result = validateReviewArtifactProof({
      reviewType: "domain",
      stack: "frontend",
      domainId: "auth",
      expectedCanonicalPath: "/abs/.../review/frontend/domains/auth.json",
      observedArtifactRef: "/abs/.../review/frontend/domains/auth.json",
      artifact: {
        stack: "frontend",
        domainId: "auth",
        reviewerSlot: "frontend-domain-reviewer",
        status: "passed",
        startedAt: "2026-04-19T12:10:00.000Z",
        completedAt: "2026-04-19T12:12:00.000Z",
        summary: "approved",
        artifactRef: "artifact://r-1",
      },
    });
    expect(result.ok).toBe(true);
  });

  test("rejects an invalid artifact shape with a structured reason", () => {
    const result = validateReviewArtifactProof({
      reviewType: "stack",
      stack: "frontend",
      domainId: null,
      expectedCanonicalPath: "/abs/.../review/frontend/stack.json",
      observedArtifactRef: "/abs/.../review/frontend/stack.json",
      artifact: { stack: "frontend" }, // missing required fields
    });
    expect(result.ok).toBe(false);
  });
});
