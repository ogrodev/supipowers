import type { PlatformPaths } from "../../platform/types.js";
import type {
  UltraPlanAgentSlotName,
  UltraPlanAuthoredArtifact,
  UltraPlanCursor,
  UltraPlanExecutionPhase,
  UltraPlanManifest,
  UltraPlanReviewStatus,
  UltraPlanScenario,
  UltraPlanScenarioStatus,
  UltraPlanStack,
  UltraPlanStackId,
} from "../../types.js";
import { hasRequiredUltraPlanScenarioProof } from "../contracts.js";
import {
  getUltraplanDomainReviewPath,
  getUltraplanStackReviewPath,
} from "../project-paths.js";

export interface UltraPlanExecutionReviewMaps {
  domainReviews: ReadonlyMap<UltraPlanStackId, ReadonlyMap<string, UltraPlanReviewStatus>>;
  stackReviews: ReadonlyMap<UltraPlanStackId, UltraPlanReviewStatus>;
}

export interface ResolveNextExecutionTargetInput {
  paths: PlatformPaths;
  cwd: string;
  authored: UltraPlanAuthoredArtifact;
  manifest: UltraPlanManifest;
  reviews?: UltraPlanExecutionReviewMaps;
}

export interface UltraPlanExecutionTarget extends UltraPlanCursor {
  requiredSlot: UltraPlanAgentSlotName | null;
  reviewArtifactPath: string | null;
}

const TERMINAL_SCENARIO_STATUSES = new Set<UltraPlanScenarioStatus>([
  "green-proved",
  "review-passed",
  "done",
 ]);

export function resolveNextExecutionTarget(input: ResolveNextExecutionTargetInput): UltraPlanExecutionTarget {
  for (const stack of input.authored.stacks) {
    if (stack.applicability === "not-applicable") {
      continue;
    }

    const stackTarget = resolveStackTarget(input, stack);
    if (stackTarget) {
      return stackTarget;
    }
  }

  return {
    targetType: "session",
    stack: null,
    domainId: null,
    level: null,
    scenarioId: null,
    phase: "complete",
    status: "complete",
    summary: "Session complete",
    requiredSlot: null,
    reviewArtifactPath: null,
  };
}

function resolveStackTarget(
  input: ResolveNextExecutionTargetInput,
  stack: UltraPlanStack,
 ): UltraPlanExecutionTarget | null {
  for (const domain of stack.domains) {
    const scenarioTarget =
      resolveScenarioTarget(stack, domain.unit)
      ?? resolveScenarioTarget(stack, domain.integration)
      ?? resolveScenarioTarget(stack, domain.e2e);

    if (scenarioTarget) {
      return scenarioTarget;
    }

    if (!stack.agentSlots.domainReviewEnabled || !domain.review.enabled) {
      continue;
    }

    const reviewStatus = readDomainReviewStatus(input, stack.stack, domain.id) ?? "pending";
    if (reviewStatus !== "passed") {
      const reviewerSlot = stack.agentSlots.domainReviewer?.slot ?? null;
      return {
        targetType: "domain-review",
        stack: stack.stack,
        domainId: domain.id,
        level: null,
        scenarioId: null,
        phase: reviewStatus === "blocked" || reviewerSlot === null ? "waiting" : "review",
        status: reviewerSlot === null ? "blocked" : reviewStatus,
        summary: reviewerSlot === null
          ? `${stack.stack} / ${domain.id} / domain review blocked — missing reviewer slot`
          : `${stack.stack} / ${domain.id} / domain review`,
        requiredSlot: reviewerSlot,
        reviewArtifactPath: getUltraplanDomainReviewPath(input.paths, input.cwd, input.authored.sessionId, stack.stack, domain.id),
      };
    }
  }

  if (!stack.agentSlots.stackReviewEnabled) {
    return null;
  }

  const reviewStatus = readStackReviewStatus(input, stack.stack) ?? "pending";
  if (reviewStatus === "passed") {
    return null;
  }

  const reviewerSlot = stack.agentSlots.stackReviewer?.slot ?? null;
  return {
    targetType: "stack-review",
    stack: stack.stack,
    domainId: null,
    level: null,
    scenarioId: null,
    phase: reviewStatus === "blocked" || reviewerSlot === null ? "waiting" : "review",
    status: reviewerSlot === null ? "blocked" : reviewStatus,
    summary: reviewerSlot === null
      ? `${stack.stack} / stack review blocked — missing reviewer slot`
      : `${stack.stack} / stack review`,
    requiredSlot: reviewerSlot,
    reviewArtifactPath: getUltraplanStackReviewPath(input.paths, input.cwd, input.authored.sessionId, stack.stack),
  };
}

function resolveScenarioTarget(stack: UltraPlanStack, scenarios: readonly UltraPlanScenario[]): UltraPlanExecutionTarget | null {
  for (const scenario of scenarios) {
    if (TERMINAL_SCENARIO_STATUSES.has(scenario.status) && hasRequiredUltraPlanScenarioProof(scenario)) {
      continue;
    }

    const phase = getScenarioPhase(scenario.status);
    return {
      targetType: "scenario",
      stack: scenario.stack,
      domainId: scenario.domainId,
      level: scenario.level,
      scenarioId: scenario.id,
      phase,
      status: scenario.status,
      summary: `${scenario.stack} / ${scenario.domainId} / ${scenario.level} / ${scenario.title}`,
      requiredSlot: resolveScenarioSlot(stack, scenario.level, phase),
      reviewArtifactPath: null,
    };
  }

  return null;
}

function resolveScenarioSlot(
  stack: UltraPlanStack,
  level: UltraPlanScenario["level"],
  phase: UltraPlanExecutionPhase,
): UltraPlanAgentSlotName | null {
  switch (phase) {
    case "red":
      return level === "unit" ? stack.agentSlots.executor.slot : stack.agentSlots.tester.slot;
    case "green":
      return stack.agentSlots.executor.slot;
    default:
      return null;
  }
}

function readDomainReviewStatus(
  input: ResolveNextExecutionTargetInput,
  stack: UltraPlanStackId,
  domainId: string,
): UltraPlanReviewStatus | null {
  const fromMap = input.reviews?.domainReviews.get(stack)?.get(domainId);
  if (fromMap) {
    return fromMap;
  }

  return input.manifest.reviews.find(
    (review) => review.type === "domain" && review.stack === stack && review.domainId === domainId,
  )?.status ?? null;
}

function readStackReviewStatus(
  input: ResolveNextExecutionTargetInput,
  stack: UltraPlanStackId,
): UltraPlanReviewStatus | null {
  const fromMap = input.reviews?.stackReviews.get(stack);
  if (fromMap) {
    return fromMap;
  }

  return input.manifest.reviews.find((review) => review.type === "stack" && review.stack === stack)?.status ?? null;
}

function getScenarioPhase(status: UltraPlanScenarioStatus): UltraPlanCursor["phase"] {
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
    case "green-proved":
    case "review-passed":
    case "done":
      return "complete";
  }
}
