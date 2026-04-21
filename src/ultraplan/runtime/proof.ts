import { createHash } from "node:crypto";
import type {
  UltraPlanBlockerCandidate,
  UltraPlanExecutionPhase,
  UltraPlanHookObservation,
  UltraPlanProofCandidate,
  UltraPlanProofCandidateTarget,
  UltraPlanStackId,
} from "../../types.js";
import {
  isUltraPlanDomainReview,
  isUltraPlanStackReview,
} from "../contracts.js";
import {
  buildProofInvalidBlocker,
} from "./blockers.js";

/**
 * Slice-2 proof extraction.
 *
 * Converts `tool_result` / `agent_end` observations into typed proof candidates. Fail-closed:
 * phase or target mismatches become `proof-invalid` blocker candidates, never silent advancement.
 * Pure — no I/O.
 */

export interface ExtractProofInput {
  observation: UltraPlanHookObservation;
  /**
   * Raw platform payload. When the payload has a structured `proof` object of shape
   * `{ type, phase, evidence, artifactRef? }`, that value is treated as a proof candidate.
   */
  payload: Record<string, unknown>;
  expectedTarget: UltraPlanProofCandidateTarget;
  expectedPhase: UltraPlanExecutionPhase;
}

export type ExtractProofResult =
  | { kind: "proof"; proof: UltraPlanProofCandidate }
  | { kind: "blocker-candidate"; blocker: UltraPlanBlockerCandidate }
  | { kind: "none" };

export function extractProofCandidate(input: ExtractProofInput): ExtractProofResult {
  const raw = input.payload?.proof;
  if (raw === undefined || raw === null) {
    return { kind: "none" };
  }

  const parsed = parseProofShape(raw);
  if (!parsed) {
    return {
      kind: "blocker-candidate",
      blocker: {
        blocker: buildProofInvalidBlocker({
          detectedAt: input.observation.occurredAt,
          scope: "scenario",
          affected: toAffected(input.expectedTarget),
          reason: "payload.proof is not a well-formed proof object",
        }),
        observationFingerprint: input.observation.fingerprint,
      },
    };
  }

  // Phase mismatch: reducer spec §proof obligations requires exact phase alignment.
  if (parsed.phase !== input.expectedPhase) {
    return {
      kind: "blocker-candidate",
      blocker: {
        blocker: buildProofInvalidBlocker({
          detectedAt: input.observation.occurredAt,
          scope: "scenario",
          affected: toAffected(input.expectedTarget),
          reason: `expected ${input.expectedPhase}-phase proof, received ${parsed.phase}-phase proof`,
        }),
        observationFingerprint: input.observation.fingerprint,
      },
    };
  }

  // Target mismatch: observation.target must align with the expected target.
  if (!observationTargetMatchesExpected(input.observation, input.expectedTarget)) {
    return {
      kind: "blocker-candidate",
      blocker: {
        blocker: buildProofInvalidBlocker({
          detectedAt: input.observation.occurredAt,
          scope: "scenario",
          affected: toAffected(input.expectedTarget),
          reason: "proof target does not match the expected attempt target",
        }),
        observationFingerprint: input.observation.fingerprint,
      },
    };
  }

  const candidate: UltraPlanProofCandidate = {
    phase: parsed.phase,
    type: parsed.type,
    target: input.expectedTarget,
    evidence: parsed.evidence,
    artifactRef: parsed.artifactRef ?? null,
    observationFingerprint: input.observation.fingerprint,
    fingerprint: computeProofFingerprint({
      observationFingerprint: input.observation.fingerprint,
      phase: parsed.phase,
      type: parsed.type,
      target: input.expectedTarget,
      evidence: parsed.evidence,
      artifactRef: parsed.artifactRef ?? null,
    }),
  };
  return { kind: "proof", proof: candidate };
}

// ---------------------------------------------------------------------------
// Review artifact validation (spec §proof obligations line 602)
// ---------------------------------------------------------------------------

export interface ValidateReviewArtifactInput {
  reviewType: "domain" | "stack";
  stack: UltraPlanStackId;
  domainId: string | null;
  expectedCanonicalPath: string;
  observedArtifactRef: string;
  artifact: unknown;
}

export type ValidateReviewArtifactResult =
  | { ok: true }
  | { ok: false; reason: string };

export function validateReviewArtifactProof(input: ValidateReviewArtifactInput): ValidateReviewArtifactResult {
  if (input.observedArtifactRef !== input.expectedCanonicalPath) {
    return {
      ok: false,
      reason: `review artifact must live at canonical path ${input.expectedCanonicalPath}, observed ${input.observedArtifactRef}`,
    };
  }

  if (input.reviewType === "domain") {
    if (!isUltraPlanDomainReview(input.artifact)) {
      return { ok: false, reason: "domain review artifact failed schema validation" };
    }
    const artifact = input.artifact;
    if (artifact.status !== "passed") {
      return { ok: false, reason: `domain review artifact status is ${artifact.status}, expected passed` };
    }
    if (artifact.stack !== input.stack || artifact.domainId !== input.domainId) {
      return { ok: false, reason: "domain review artifact stack/domainId does not match review target" };
    }
    return { ok: true };
  }

  // stack review
  if (!isUltraPlanStackReview(input.artifact)) {
    return { ok: false, reason: "stack review artifact failed schema validation" };
  }
  const artifact = input.artifact;
  if (artifact.status !== "passed") {
    return { ok: false, reason: `stack review artifact status is ${artifact.status}, expected passed` };
  }
  if (artifact.stack !== input.stack) {
    return { ok: false, reason: "stack review artifact stack does not match review target" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface ParsedProofShape {
  type: UltraPlanProofCandidate["type"];
  phase: UltraPlanExecutionPhase;
  evidence: { summary: string; command?: string; outputRef?: string; metadata?: Record<string, unknown> };
  artifactRef?: string;
}

const VALID_PROOF_TYPES: readonly string[] = ["test", "command", "review", "artifact"];
const VALID_PHASES: readonly string[] = ["red", "green", "review", "waiting", "complete"];

function parseProofShape(raw: unknown): ParsedProofShape | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.type !== "string" || !VALID_PROOF_TYPES.includes(obj.type)) return null;
  if (typeof obj.phase !== "string" || !VALID_PHASES.includes(obj.phase)) return null;
  if (!obj.evidence || typeof obj.evidence !== "object") return null;
  const ev = obj.evidence as Record<string, unknown>;
  if (typeof ev.summary !== "string" || ev.summary.length === 0) return null;

  const parsed: ParsedProofShape = {
    type: obj.type as UltraPlanProofCandidate["type"],
    phase: obj.phase as UltraPlanExecutionPhase,
    evidence: {
      summary: ev.summary,
      ...(typeof ev.command === "string" ? { command: ev.command } : {}),
      ...(typeof ev.outputRef === "string" ? { outputRef: ev.outputRef } : {}),
      ...(ev.metadata && typeof ev.metadata === "object" && !Array.isArray(ev.metadata)
        ? { metadata: ev.metadata as Record<string, unknown> }
        : {}),
    },
  };
  if (typeof obj.artifactRef === "string" && obj.artifactRef.length > 0) {
    parsed.artifactRef = obj.artifactRef;
  }
  return parsed;
}

function toAffected(target: UltraPlanProofCandidateTarget) {
  return {
    stack: target.stack,
    domainId: target.domainId,
    level: target.level,
    scenarioId: target.scenarioId,
  };
}

function observationTargetMatchesExpected(
  observation: UltraPlanHookObservation,
  expected: UltraPlanProofCandidateTarget,
): boolean {
  const obsTarget = observation.target;
  if (!obsTarget) return false;
  return obsTarget.targetType === expected.targetType
    && obsTarget.stack === expected.stack
    && obsTarget.domainId === expected.domainId
    && obsTarget.level === expected.level
    && obsTarget.scenarioId === expected.scenarioId;
}

function computeProofFingerprint(parts: {
  observationFingerprint: string;
  phase: UltraPlanExecutionPhase;
  type: UltraPlanProofCandidate["type"];
  target: UltraPlanProofCandidateTarget;
  evidence: ParsedProofShape["evidence"];
  artifactRef: string | null;
}): string {
  const canonical = JSON.stringify({
    observationFingerprint: parts.observationFingerprint,
    phase: parts.phase,
    type: parts.type,
    target: canonicalize(parts.target),
    evidence: canonicalize(parts.evidence),
    artifactRef: parts.artifactRef,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, canonicalize(v)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}
