import type {
  UltraPlanAuthoredArtifact,
  UltraPlanCursor,
  UltraPlanManifest,
  UltraPlanReviewStatus,
  UltraPlanScenario,
  UltraPlanScenarioStatus,
  UltraPlanSessionBucket,
  UltraPlanSessionState,
  UltraPlanSessionSummary,
  UltraPlanStack,
} from "../types.js";
import { hasRequiredUltraPlanScenarioProof } from "./contracts.js";


export interface UltraPlanVisibleSession extends UltraPlanSessionSummary {
  bucket: UltraPlanSessionBucket;
  idleReasonLabel: string | null;
}

export interface UltraPlanResolvedCursor {
  cursor: UltraPlanCursor;
  source: "persisted" | "recomputed";
}

const TERMINAL_SCENARIO_STATUSES = new Set<UltraPlanScenarioStatus>([
  "green-proved",
  "review-passed",
  "done",
]);
const ONGOING_CURSOR_STATUSES = new Set([
  "red-running",
  "green-running",
  "in-review",
]);


export function mapUltraPlanStateToBucket(state: UltraPlanSessionState): UltraPlanSessionBucket {
  switch (state) {
    case "ready":
      return "pending";
    case "running":
      return "ongoing";
    case "blocked":
    case "awaiting-user":
      return "idle";
    case "complete":
    case "discarded":
      return "done";
  }
}

export function getUltraPlanIdleReasonLabel(session: UltraPlanSessionSummary): string | null {
  if (session.state === "awaiting-user") {
    return session.blocker?.message ? `Awaiting user: ${session.blocker.message}` : "Awaiting user input";
  }

  if (session.state === "blocked") {
    return session.blocker?.message ?? "Blocked";
  }

  return null;
}

export function resolveUltraPlanSessionBucket(
  session: UltraPlanSessionSummary,
  resolved?: UltraPlanResolvedCursor,
): UltraPlanSessionBucket {
  const cursor = resolved?.cursor ?? session.cursor;

  if (session.state === "discarded") {
    return "done";
  }

  if (!resolved && session.state === "complete") {
    return "done";
  }

  if (cursor?.targetType === "session" && cursor.status === "complete") {
    return "done";
  }

  if (session.state === "awaiting-user") {
    return "idle";
  }

  if (session.state === "blocked" || cursor?.status === "blocked") {
    return "idle";
  }

  if (session.state === "running" || (cursor && ONGOING_CURSOR_STATUSES.has(cursor.status))) {
    return "ongoing";
  }

  return "pending";
}

export function getVisibleUltraPlanSessions(
  sessions: UltraPlanSessionSummary[],
  options?: { includeDone?: boolean },
): UltraPlanVisibleSession[] {
  const includeDone = options?.includeDone ?? false;

  return sessions
    .map((session) => ({
      ...session,
      bucket: resolveUltraPlanSessionBucket(session),
      idleReasonLabel: getUltraPlanIdleReasonLabel(session),
    }))
    .filter((session) => includeDone || session.bucket !== "done");
}

export function isUltraPlanCursorSummaryValid(
  manifest: UltraPlanManifest,
  authored: UltraPlanAuthoredArtifact,
): boolean {
  if (!manifest.cursor) {
    return false;
  }

  return sameCursor(manifest.cursor, recomputeUltraPlanCursor(manifest, authored));
}

export function resolveUltraPlanCurrentCursor(
  manifest: UltraPlanManifest,
  authored: UltraPlanAuthoredArtifact,
): UltraPlanResolvedCursor {
  const recomputed = recomputeUltraPlanCursor(manifest, authored);
  if (manifest.cursor && sameCursor(manifest.cursor, recomputed)) {
    return { cursor: recomputed, source: "persisted" };
  }

  return { cursor: recomputed, source: "recomputed" };
}

function recomputeUltraPlanCursor(manifest: UltraPlanManifest, authored: UltraPlanAuthoredArtifact): UltraPlanCursor {
  for (const stack of authored.stacks) {
    if (stack.applicability === "not-applicable") {
      continue;
    }

    const stackCursor = recomputeStackCursor(manifest, stack);
    if (stackCursor) {
      return stackCursor;
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
  };
}

function recomputeStackCursor(manifest: UltraPlanManifest, stack: UltraPlanStack): UltraPlanCursor | null {
  for (const domain of stack.domains) {
    const scenarioCursor = findFirstScenarioCursor(domain.unit)
      ?? findFirstScenarioCursor(domain.integration)
      ?? findFirstScenarioCursor(domain.e2e);

    if (scenarioCursor) {
      return scenarioCursor;
    }

    if (stack.agentSlots.domainReviewEnabled && domain.review.enabled) {
      if (!stack.agentSlots.domainReviewer) {
        return {
          targetType: "domain-review",
          stack: stack.stack,
          domainId: domain.id,
          level: null,
          scenarioId: null,
          phase: "waiting",
          status: "blocked",
          summary: `${stack.stack} / ${domain.id} / domain review blocked — missing reviewer slot`,
        };
      }

      const reviewStatus = getDomainReviewStatus(manifest, stack.stack, domain.id) ?? "pending";
      if (reviewStatus !== "passed") {
        return {
          targetType: "domain-review",
          stack: stack.stack,
          domainId: domain.id,
          level: null,
          scenarioId: null,
          phase: reviewStatus === "blocked" ? "waiting" : "review",
          status: reviewStatus,
          summary: `${stack.stack} / ${domain.id} / domain review`,
        };
      }
    }
  }

  if (stack.agentSlots.stackReviewEnabled) {
    if (!stack.agentSlots.stackReviewer) {
      return {
        targetType: "stack-review",
        stack: stack.stack,
        domainId: null,
        level: null,
        scenarioId: null,
        phase: "waiting",
        status: "blocked",
        summary: `${stack.stack} / stack review blocked — missing reviewer slot`,
      };
    }

    const reviewStatus = getStackReviewStatus(manifest, stack.stack) ?? "pending";
    if (reviewStatus !== "passed") {
      return {
        targetType: "stack-review",
        stack: stack.stack,
        domainId: null,
        level: null,
        scenarioId: null,
        phase: reviewStatus === "blocked" ? "waiting" : "review",
        status: reviewStatus,
        summary: `${stack.stack} / stack review`,
      };
    }
  }

  return null;
}

function findFirstScenarioCursor(scenarios: UltraPlanScenario[]): UltraPlanCursor | null {
  for (const scenario of scenarios) {
    if (!TERMINAL_SCENARIO_STATUSES.has(scenario.status) || !hasRequiredUltraPlanScenarioProof(scenario)) {
      return {
        targetType: "scenario",
        stack: scenario.stack,
        domainId: scenario.domainId,
        level: scenario.level,
        scenarioId: scenario.id,
        phase: getScenarioPhase(scenario.status),
        status: scenario.status,
        summary: `${scenario.stack} / ${scenario.domainId} / ${scenario.level} / ${scenario.title}`,
      };
    }
  }

  return null;
}

function getDomainReviewStatus(
  manifest: UltraPlanManifest,
  stack: UltraPlanStack["stack"],
  domainId: string,
): UltraPlanReviewStatus | null {
  return manifest.reviews.find((review) => review.type === "domain" && review.stack === stack && review.domainId === domainId)?.status ?? null;
}

function getStackReviewStatus(manifest: UltraPlanManifest, stack: UltraPlanStack["stack"]): UltraPlanReviewStatus | null {
  return manifest.reviews.find((review) => review.type === "stack" && review.stack === stack)?.status ?? null;
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

function sameCursor(left: UltraPlanCursor, right: UltraPlanCursor): boolean {
  return left.targetType === right.targetType
    && left.stack === right.stack
    && left.domainId === right.domainId
    && left.level === right.level
    && left.scenarioId === right.scenarioId
    && left.phase === right.phase
    && left.status === right.status
    && left.summary === right.summary;
}
