import type { UltraPlanVisibleSession } from "./session-selection.js";

export type UltraPlanRecommendationAction = "run" | "inspect";

export type UltraPlanRecommendationReasonCode =
  | "ongoing"
  | "pending"
  | "awaiting-user"
  | "blocked-manual"
  | "blocked"
  | "mismatch";

export interface UltraPlanSessionRecommendation {
  session: UltraPlanVisibleSession;
  action: UltraPlanRecommendationAction;
  reasonCode: UltraPlanRecommendationReasonCode;
}

type ClassifiedRecommendation = UltraPlanSessionRecommendation & {
  priority: number;
};

const RECOMMENDATION_PRIORITY: Record<UltraPlanRecommendationReasonCode, number> = {
  ongoing: 0,
  pending: 1,
  "awaiting-user": 2,
  "blocked-manual": 3,
  blocked: 4,
  mismatch: 5,
};

export function rankUltraPlanVisibleSessions(
  sessions: readonly UltraPlanVisibleSession[],
): UltraPlanSessionRecommendation[] {
  return sessions
    .map(classifyUltraPlanVisibleSession)
    .filter((recommendation): recommendation is ClassifiedRecommendation => recommendation !== null)
    .sort(compareRecommendations)
    .map(({ priority: _priority, ...recommendation }) => recommendation);
}

function classifyUltraPlanVisibleSession(
  session: UltraPlanVisibleSession,
): ClassifiedRecommendation | null {
  switch (session.state) {
    case "complete":
    case "discarded":
      return null;
    case "running":
      return buildRecommendation(session, session.bucket === "ongoing" ? "ongoing" : "mismatch");
    case "ready":
      return buildRecommendation(session, session.bucket === "pending" ? "pending" : "mismatch");
    case "awaiting-user":
      return buildRecommendation(session, session.bucket === "idle" ? "awaiting-user" : "mismatch");
    case "blocked":
      if (session.bucket !== "idle") {
        return buildRecommendation(session, "mismatch");
      }
      return buildRecommendation(
        session,
        session.blocker?.recoveryMode === "manual" ? "blocked-manual" : "blocked",
      );
  }
}

function buildRecommendation(
  session: UltraPlanVisibleSession,
  reasonCode: UltraPlanRecommendationReasonCode,
): ClassifiedRecommendation {
  return {
    session,
    action: reasonCode === "ongoing" || reasonCode === "pending" ? "run" : "inspect",
    reasonCode,
    priority: RECOMMENDATION_PRIORITY[reasonCode],
  };
}

function compareRecommendations(
  left: ClassifiedRecommendation,
  right: ClassifiedRecommendation,
): number {
  return left.priority - right.priority
    || left.session.title.localeCompare(right.session.title)
    || left.session.sessionId.localeCompare(right.session.sessionId);
}
