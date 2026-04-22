import { createHash } from "node:crypto";
import * as fs from "node:fs";
import type { Platform } from "../../platform/types.js";
import type {
  UltraPlanAttemptRecord,
  UltraPlanCursor,
  UltraPlanDomain,
  UltraPlanHookObservation,
  UltraPlanManifest,
  UltraPlanManifestReviewReference,
  UltraPlanMutationPlan,
  UltraPlanPendingMutation,
  UltraPlanRuntimeTracker,
  UltraPlanScenario,
  UltraPlanSessionState,
  UltraPlanStack,
} from "../../types.js";
import { hasRequiredUltraPlanScenarioProof } from "../contracts.js";
import {
  getUltraplanDomainReviewPath,
  getUltraplanManifestPath,
  getUltraplanStackReviewPath,
} from "../project-paths.js";
import { resolveUltraPlanCurrentCursor } from "../session-selection.js";
import {
  loadUltraPlanAuthoredArtifact,
  loadUltraPlanManifest,
  saveUltraPlanAuthoredArtifact,
  saveUltraPlanManifest,
  validateUltraPlanManifestReviewReferences,
} from "../storage.js";
import {
  appendExecutionLog,
  appendHookLog,
  loadTracker,
  saveTrackerAtomic,
} from "./tracker-storage.js";

export interface ApplyUltraPlanMutationInput {
  platform: Platform;
  cwd: string;
  sessionId: string;
  observation: UltraPlanHookObservation;
  mutationPlan: UltraPlanMutationPlan;
}

export function applyUltraPlanMutation(input: ApplyUltraPlanMutationInput): void {
  const tracker = loadTrackerOrEmpty(input);
  if (tracker.appliedFingerprints.includes(input.observation.fingerprint)) {
    return;
  }

  assertStorageResult(appendHookLog(input.platform.paths, input.cwd, input.sessionId, input.observation));
  if (input.mutationPlan.kind !== "noop") {
    assertStorageResult(
      appendExecutionLog(input.platform.paths, input.cwd, input.sessionId, buildExecutionLogEntry(input)),
    );
  }

  const stagedTracker = buildNextTracker(tracker, input);
  const needsCanonicalWrites = requiresPendingMutation(input.mutationPlan);

  if (!needsCanonicalWrites) {
    assertStorageResult(saveTrackerAtomic(input.platform.paths, input.cwd, input.sessionId, stagedTracker));
    return;
  }

  // Stage tracker truth first so an interrupted manifest/authored write leaves a durable replay point.
  assertStorageResult(saveTrackerAtomic(input.platform.paths, input.cwd, input.sessionId, stagedTracker));

  const authoredResult = loadUltraPlanAuthoredArtifact(input.platform.paths, input.cwd, input.sessionId);
  if (!authoredResult.ok) {
    throwStorageError(authoredResult.error);
  }
  const manifestResult = loadUltraPlanManifest(input.platform.paths, input.cwd, input.sessionId);
  if (!manifestResult.ok) {
    throwStorageError(manifestResult.error);
  }

  const nextAuthored = structuredClone(authoredResult.value);
  const nextManifest = structuredClone(manifestResult.value);

  applyScenarioStatusUpdate(nextAuthored, input.mutationPlan);
  applyReviewStatusUpdate(input, nextManifest);
  applyBlockerUpdate(nextManifest, input.mutationPlan);

  nextManifest.updatedAt = input.observation.occurredAt;
  nextManifest.stacks = buildManifestStacks(nextAuthored, nextManifest);
  nextManifest.progress = buildSessionProgress(nextManifest.stacks, nextManifest.blocker);
  nextManifest.cursor = resolveUltraPlanCurrentCursor(nextManifest, nextAuthored).cursor;
  nextManifest.state = resolveManifestState(nextManifest, stagedTracker, input.mutationPlan.sessionStateUpdate);

  assertStorageResult(validateUltraPlanManifestReviewReferences(input.platform.paths, input.cwd, input.sessionId, nextManifest));

  assertStorageResult(saveUltraPlanAuthoredArtifact(input.platform.paths, input.cwd, input.sessionId, nextAuthored));
  assertStorageResult(saveUltraPlanManifest(input.platform.paths, input.cwd, input.sessionId, nextManifest));

  const finalizedTracker: UltraPlanRuntimeTracker = {
    ...stagedTracker,
    pendingMutation: null,
    updatedAt: input.observation.occurredAt,
  };
  assertStorageResult(saveTrackerAtomic(input.platform.paths, input.cwd, input.sessionId, finalizedTracker));
}

function loadTrackerOrEmpty(input: ApplyUltraPlanMutationInput): UltraPlanRuntimeTracker {
  const loaded = loadTracker(input.platform.paths, input.cwd, input.sessionId);
  if (loaded.ok) {
    return loaded.value;
  }

  if (loaded.error.kind !== "missing") {
    const detail = loaded.error.details?.length ? `\n${loaded.error.details.join("\n")}` : "";
    throw new Error(`${loaded.error.message}${detail}`);
  }

  return {
    version: 1,
    sessionId: input.sessionId,
    activeAttempt: null,
    finalizedAttempts: [],
    appliedFingerprints: [],
    pendingMutation: null,
    updatedAt: input.observation.occurredAt,
  };
}

function buildNextTracker(
  tracker: UltraPlanRuntimeTracker,
  input: ApplyUltraPlanMutationInput,
): UltraPlanRuntimeTracker {
  const { observation, mutationPlan } = input;
  const next: UltraPlanRuntimeTracker = {
    ...tracker,
    activeAttempt: tracker.activeAttempt ? updateActiveAttempt(tracker.activeAttempt, observation, mutationPlan) : null,
    updatedAt: observation.occurredAt,
  };

  if (mutationPlan.kind === "start-attempt") {
    next.activeAttempt = buildActiveAttempt(observation, mutationPlan);
  }

  if (mutationPlan.trackerAttemptFinalization && next.activeAttempt?.attemptId === mutationPlan.trackerAttemptFinalization.attemptId) {
    next.finalizedAttempts = [
      ...next.finalizedAttempts,
      {
        ...next.activeAttempt,
        outcome: mutationPlan.trackerAttemptFinalization.outcome,
        finalizedAt: mutationPlan.trackerAttemptFinalization.finalizedAt,
      },
    ];
    next.activeAttempt = null;
  }

  if (mutationPlan.appendObservationFingerprint) {
    next.appliedFingerprints = [
      ...next.appliedFingerprints,
      mutationPlan.appendObservationFingerprint,
    ];
  }

  if (requiresPendingMutation(mutationPlan)) {
    next.pendingMutation = buildPendingMutation(input);
  }

  return next;
}

function buildActiveAttempt(
  observation: UltraPlanHookObservation,
  mutationPlan: UltraPlanMutationPlan,
): UltraPlanAttemptRecord | null {
  if (!observation.attemptId || !observation.attemptKey) {
    return null;
  }

  return {
    attemptId: observation.attemptId,
    attemptKey: observation.attemptKey,
    launchContext: {
      attemptId: observation.attemptId,
      attemptKey: observation.attemptKey,
      sourceAgent: observation.sourceAgent,
      launchedAt: observation.occurredAt,
    },
    cursorSnapshot: mutationPlan.cursorUpdate,
    observations: [observation],
    proofCandidates: [],
    blockerCandidates: [],
    outcome: null,
    startedAt: observation.occurredAt,
    finalizedAt: null,
  };
}

function updateActiveAttempt(
  attempt: UltraPlanAttemptRecord,
  observation: UltraPlanHookObservation,
  mutationPlan: UltraPlanMutationPlan,
): UltraPlanAttemptRecord {
  if (!observation.attemptId || observation.attemptId !== attempt.attemptId) {
    return attempt;
  }

  return {
    ...attempt,
    cursorSnapshot: mutationPlan.cursorUpdate ?? attempt.cursorSnapshot,
    observations: [...attempt.observations, observation],
  };
}

function requiresPendingMutation(mutationPlan: UltraPlanMutationPlan): boolean {
  return mutationPlan.cursorUpdate !== null
    || mutationPlan.scenarioStatusUpdate !== null
    || mutationPlan.reviewStatusUpdate !== null
    || mutationPlan.blockerUpdate !== null
    || mutationPlan.sessionStateUpdate !== null
    || mutationPlan.recomputeProgress;
}

function buildPendingMutation(input: ApplyUltraPlanMutationInput): UltraPlanPendingMutation {
  return {
    attemptId: input.observation.attemptId ?? input.sessionId,
    mutationPlan: input.mutationPlan,
    expectedManifestFingerprint: computeManifestFingerprint(input),
    stagedAt: input.observation.occurredAt,
  };
}

function computeManifestFingerprint(input: ApplyUltraPlanMutationInput): string {
  const manifestPath = getUltraplanManifestPath(input.platform.paths, input.cwd, input.sessionId);
  if (!fs.existsSync(manifestPath)) {
    return `missing:${manifestPath}`;
  }

  return `sha256:${createHash("sha256").update(fs.readFileSync(manifestPath)).digest("hex")}`;
}

function applyScenarioStatusUpdate(authored: { stacks: UltraPlanStack[] }, mutationPlan: UltraPlanMutationPlan): void {
  const update = mutationPlan.scenarioStatusUpdate;
  if (!update) {
    return;
  }

  const stack = authored.stacks.find((candidate) => candidate.stack === update.stack);
  const domain = stack?.domains.find((candidate) => candidate.id === update.domainId);
  const scenarios = domain?.[update.level];
  const scenario = scenarios?.find((candidate) => candidate.id === update.scenarioId);
  if (!scenario) {
    throw new Error(`UltraPlan scenario not found for mutation: ${update.stack}/${update.domainId}/${update.level}/${update.scenarioId}`);
  }

  scenario.status = update.nextStatus;
  if (update.appendProof) {
    scenario.proofs = [...scenario.proofs, update.appendProof];
  }
}

function applyReviewStatusUpdate(input: ApplyUltraPlanMutationInput, manifest: UltraPlanManifest): void {
  const update = input.mutationPlan.reviewStatusUpdate;
  if (!update) {
    return;
  }

  if (update.type === "domain" && !update.domainId) {
    throw new Error("Domain review updates must include a domainId");
  }
  if (update.type === "stack" && update.domainId !== null) {
    throw new Error("Stack review updates must not include a domainId");
  }
  if (update.nextStatus === "passed" && !update.artifactRef) {
    throw new Error("Passed review updates must include an artifactRef");
  }

  const existingIndex = manifest.reviews.findIndex(
    (candidate) => candidate.type === update.type && candidate.stack === update.stack && candidate.domainId === update.domainId,
  );
  const reviewPath = update.artifactRef
    ?? (update.type === "domain"
      ? getUltraplanDomainReviewPath(input.platform.paths, input.cwd, input.sessionId, update.stack, update.domainId!)
      : getUltraplanStackReviewPath(input.platform.paths, input.cwd, input.sessionId, update.stack));

  const nextReference: UltraPlanManifestReviewReference = {
    type: update.type,
    stack: update.stack,
    domainId: update.type === "domain" ? update.domainId! : null,
    path: reviewPath,
    status: update.nextStatus,
  };

  if (existingIndex === -1) {
    manifest.reviews.push(nextReference);
    return;
  }

  manifest.reviews[existingIndex] = nextReference;
}

function applyBlockerUpdate(manifest: UltraPlanManifest, mutationPlan: UltraPlanMutationPlan): void {
  if (!mutationPlan.blockerUpdate) {
    return;
  }

  manifest.blocker = mutationPlan.blockerUpdate.nextValue;
}

function buildManifestStacks(authored: { stacks: UltraPlanStack[] }, manifest: UltraPlanManifest): UltraPlanManifest["stacks"] {
  return authored.stacks.map((stack) => {
    if (stack.applicability === "not-applicable") {
      return {
        stack: stack.stack,
        applicability: stack.applicability,
        progress: { total: 0, terminal: 0, blocked: 0 },
        domainCount: 0,
        terminalDomainCount: 0,
      };
    }

    const scenarios = stack.domains.flatMap((domain) => [...domain.unit, ...domain.integration, ...domain.e2e]);
    const blockedReviews = stack.domains.filter((domain) => readDomainReviewStatus(manifest, stack.stack, domain.id) === "blocked").length;
    const stackReviewBlocked = readStackReviewStatus(manifest, stack.stack) === "blocked" ? 1 : 0;

    return {
      stack: stack.stack,
      applicability: stack.applicability,
      progress: {
        total: scenarios.length,
        terminal: scenarios.filter(isScenarioTerminal).length,
        blocked: scenarios.filter((scenario) => scenario.status === "blocked").length + blockedReviews + stackReviewBlocked,
      },
      domainCount: stack.domains.length,
      terminalDomainCount: stack.domains.filter((domain) => isDomainTerminal(domain, manifest, stack.stack)).length,
    };
  });
}

function buildSessionProgress(
  stacks: UltraPlanManifest["stacks"],
  blocker: UltraPlanManifest["blocker"],
): UltraPlanManifest["progress"] {
  return stacks.reduce(
    (acc, stack) => ({
      total: acc.total + stack.progress.total,
      terminal: acc.terminal + stack.progress.terminal,
      blocked: acc.blocked + stack.progress.blocked,
    }),
    { total: 0, terminal: 0, blocked: blocker ? 1 : 0 },
  );
}

function isDomainTerminal(domain: UltraPlanDomain, manifest: UltraPlanManifest, stack: UltraPlanStack["stack"]): boolean {
  const scenarios = [...domain.unit, ...domain.integration, ...domain.e2e];
  if (!scenarios.every(isScenarioTerminal)) {
    return false;
  }

  if (!domain.review.enabled) {
    return true;
  }

  return readDomainReviewStatus(manifest, stack, domain.id) === "passed";
}

function isScenarioTerminal(scenario: UltraPlanScenario): boolean {
  return ["green-proved", "review-passed", "done"].includes(scenario.status)
    && hasRequiredUltraPlanScenarioProof(scenario);
}

function readDomainReviewStatus(manifest: UltraPlanManifest, stack: UltraPlanStack["stack"], domainId: string) {
  return manifest.reviews.find((review) => review.type === "domain" && review.stack === stack && review.domainId === domainId)?.status ?? null;
}

function readStackReviewStatus(manifest: UltraPlanManifest, stack: UltraPlanStack["stack"]) {
  return manifest.reviews.find((review) => review.type === "stack" && review.stack === stack)?.status ?? null;
}

function resolveManifestState(
  manifest: UltraPlanManifest,
  tracker: UltraPlanRuntimeTracker,
  explicitState: UltraPlanMutationPlan["sessionStateUpdate"],
): UltraPlanSessionState {
  const derived = explicitState
    ?? (manifest.blocker
      ? (manifest.blocker.recoveryMode === "await-user" ? "awaiting-user" : "blocked")
      : (manifest.cursor?.targetType === "session" && manifest.cursor.status === "complete")
        ? "complete"
        : tracker.activeAttempt
          ? "running"
          : "ready");

  return derived ?? manifest.state ?? "ready";
}

function buildExecutionLogEntry(input: ApplyUltraPlanMutationInput): Record<string, unknown> {
  return {
    ts: input.observation.occurredAt,
    sessionId: input.sessionId,
    attemptId: input.observation.attemptId,
    observationFingerprint: input.observation.fingerprint,
    hookEvent: input.observation.hookEvent,
    mutation: input.mutationPlan,
  };
}

function assertStorageResult(result: { ok: boolean; error?: { message: string; details?: string[] } }): void {
  if (result.ok) {
    return;
  }

  throwStorageError(result.error);
}

function throwStorageError(error: { message: string; details?: string[] } | undefined): never {
  const detail = error?.details?.length ? `\n${error.details.join("\n")}` : "";
  throw new Error(`${error?.message ?? "UltraPlan runtime storage failure"}${detail}`);
}
