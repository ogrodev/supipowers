import { describe, expect, test } from "bun:test";
import type {
  UltraPlanBlocker,
  UltraPlanSessionBucket,
  UltraPlanSessionState,
} from "../../src/types.js";
import {
  type UltraPlanRecommendationAction,
  type UltraPlanRecommendationReasonCode,
  type UltraPlanSessionRecommendation,
  rankUltraPlanVisibleSessions,
} from "../../src/ultraplan/next-router.js";
import type { UltraPlanVisibleSession } from "../../src/ultraplan/session-selection.js";

describe("rankUltraPlanVisibleSessions", () => {
  test("exports the router surface", () => {
    const surface: [
      UltraPlanRecommendationAction,
      UltraPlanRecommendationReasonCode,
      UltraPlanSessionRecommendation,
    ] | null = null;

    expect(surface).toBeNull();
    expect(rankUltraPlanVisibleSessions([])).toEqual([]);
  });

  test.each([
    {
      name: "orders actionable sessions before inspect-only sessions and excludes done sessions",
      sessions: [
        makeVisibleSession({ sessionId: "pending-b", title: "Pending beta", state: "ready", bucket: "pending" }),
        makeVisibleSession({ sessionId: "done-a", title: "Done alpha", state: "complete", bucket: "done" }),
        makeVisibleSession({ sessionId: "awaiting-a", title: "Awaiting alpha", state: "awaiting-user", bucket: "idle", blocker: makeBlocker("await-user", "Need sign-off") }),
        makeVisibleSession({ sessionId: "blocked-retry-a", title: "Blocked retry alpha", state: "blocked", bucket: "idle", blocker: makeBlocker("retry", "Need rerun") }),
        makeVisibleSession({ sessionId: "ongoing-a", title: "Ongoing alpha", state: "running", bucket: "ongoing" }),
        makeVisibleSession({ sessionId: "blocked-manual-a", title: "Blocked manual alpha", state: "blocked", bucket: "idle", blocker: makeBlocker("manual", "Need manual action") }),
      ],
      expected: [
        ["ongoing-a", "run", "ongoing"],
        ["pending-b", "run", "pending"],
        ["awaiting-a", "inspect", "awaiting-user"],
        ["blocked-manual-a", "inspect", "blocked-manual"],
        ["blocked-retry-a", "inspect", "blocked"],
      ],
    },
    {
      name: "breaks ties lexicographically by title and then sessionId",
      sessions: [
        makeVisibleSession({ sessionId: "pending-b", title: "Alpha", state: "ready", bucket: "pending" }),
        makeVisibleSession({ sessionId: "pending-a", title: "Alpha", state: "ready", bucket: "pending" }),
        makeVisibleSession({ sessionId: "pending-c", title: "Bravo", state: "ready", bucket: "pending" }),
      ],
      expected: [
        ["pending-a", "run", "pending"],
        ["pending-b", "run", "pending"],
        ["pending-c", "run", "pending"],
      ],
    },
    {
      name: "fails closed when incomplete state and bucket disagree",
      sessions: [
        makeVisibleSession({ sessionId: "mismatch-a", title: "Mismatch alpha", state: "ready", bucket: "idle" }),
        makeVisibleSession({ sessionId: "pending-a", title: "Pending alpha", state: "ready", bucket: "pending" }),
      ],
      expected: [
        ["pending-a", "run", "pending"],
        ["mismatch-a", "inspect", "mismatch"],
      ],
    },
  ])("$name", ({ sessions, expected }) => {
    expect(summarize(rankUltraPlanVisibleSessions(sessions))).toEqual(expected);
  });

  test("treats paused state as inspect-only even when the bucket looks runnable", () => {
    const sessions = [
      makeVisibleSession({
        sessionId: "blocked-pending-a",
        title: "Blocked but looks pending",
        state: "blocked",
        bucket: "pending",
        blocker: makeBlocker("retry", "Need rerun"),
      }),
      makeVisibleSession({
        sessionId: "pending-a",
        title: "Pending alpha",
        state: "ready",
        bucket: "pending",
      }),
    ];

    expect(summarize(rankUltraPlanVisibleSessions(sessions))).toEqual([
      ["pending-a", "run", "pending"],
      ["blocked-pending-a", "inspect", "mismatch"],
    ]);
  });
});

function summarize(
  recommendations: UltraPlanSessionRecommendation[],
): ReadonlyArray<readonly [string, UltraPlanRecommendationAction, UltraPlanRecommendationReasonCode]> {
  return recommendations.map(({ session, action, reasonCode }) => [
    session.sessionId,
    action,
    reasonCode,
  ] as const);
}

function makeBlocker(
  recoveryMode: UltraPlanBlocker["recoveryMode"],
  message: string,
): UltraPlanBlocker {
  return {
    code: "blocked",
    message,
    scope: "session",
    affected: {
      stack: null,
      domainId: null,
      level: null,
      scenarioId: null,
    },
    recoverable: recoveryMode !== "manual",
    recoveryMode,
    nextAction: message,
    retryable: recoveryMode === "retry",
    detectedAt: "2026-04-21T12:00:00.000Z",
  };
}

function makeVisibleSession(input: {
  sessionId: string;
  title: string;
  state: UltraPlanSessionState;
  bucket: UltraPlanSessionBucket;
  blocker?: UltraPlanBlocker | null;
}): UltraPlanVisibleSession {
  return {
    sessionId: input.sessionId,
    projectName: "supipowers",
    title: input.title,
    state: input.state,
    createdAt: "2026-04-21T12:00:00.000Z",
    updatedAt: "2026-04-21T12:05:00.000Z",
    cursor: null,
    lastCompleted: null,
    blocker: input.blocker ?? null,
    progress: {
      total: 1,
      terminal: 0,
      blocked: input.blocker ? 1 : 0,
    },
    stacks: [],
    reviews: [],
    bucket: input.bucket,
    idleReasonLabel: input.state === "awaiting-user"
      ? `Awaiting user: ${input.blocker?.message ?? "Need input"}`
      : input.blocker?.message ?? null,
  };
}
