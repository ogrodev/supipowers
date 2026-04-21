import { describe, expect, test } from "bun:test";
import type { UltraPlanCursor, UltraPlanSessionSummary } from "../../src/types.js";
import type { UltraPlanResolvedCursor, UltraPlanVisibleSession } from "../../src/ultraplan/session-selection.js";
import { buildUltraPlanPickerOptions, renderUltraPlanStatus } from "../../src/ultraplan/presenter.js";
import { makeUltraPlanAuthored, makeUltraPlanScenario, makeUltraPlanStack } from "./fixtures.js";

const authored = makeUltraPlanAuthored({
  stacks: [makeUltraPlanStack({
    domains: [
      {
        id: "auth",
        name: "Authentication",
        unit: [
          makeUltraPlanScenario("scenario-a", "First scenario", "done"),
          makeUltraPlanScenario("scenario-b", "Second scenario", "planned"),
        ],
        integration: [],
        e2e: [],
        review: {
          enabled: true,
          status: "pending",
        },
        progress: {
          total: 2,
          terminal: 1,
          blocked: 0,
        },
      },
    ],
    progress: {
      total: 2,
      terminal: 1,
      blocked: 0,
    },
  })],
});

const currentCursor: UltraPlanCursor = {
  targetType: "scenario",
  stack: "frontend",
  domainId: "auth",
  level: "unit",
  scenarioId: "scenario-b",
  phase: "red",
  status: "planned",
  summary: "frontend / auth / unit / Second scenario",
};

const lastCompleted: UltraPlanCursor = {
  targetType: "scenario",
  stack: "frontend",
  domainId: "auth",
  level: "unit",
  scenarioId: "scenario-a",
  phase: "complete",
  status: "done",
  summary: "frontend / auth / unit / First scenario",
};

function makeSummary(state: UltraPlanSessionSummary["state"], title: string, blockerMessage?: string): UltraPlanSessionSummary {
  return {
    sessionId: `${title.toLowerCase().replace(/\s+/g, "-")}`,
    projectName: "supipowers",
    title,
    state,
    createdAt: "2026-04-19T12:00:00.000Z",
    updatedAt: "2026-04-19T12:15:00.000Z",
    cursor: currentCursor,
    lastCompleted,
    blocker: blockerMessage
      ? {
          code: "blocked",
          message: blockerMessage,
          scope: "session",
          affected: {
            stack: null,
            domainId: null,
            level: null,
            scenarioId: null,
          },
          recoverable: true,
          recoveryMode: "await-user",
          nextAction: "Wait for user input",
          retryable: false,
          detectedAt: "2026-04-19T12:16:00.000Z",
        }
      : null,
    progress: {
      total: 2,
      terminal: 1,
      blocked: blockerMessage ? 1 : 0,
    },
    stacks: [
      {
        stack: "frontend",
        applicability: "applicable",
        progress: {
          total: 1,
          terminal: 0,
          blocked: blockerMessage ? 1 : 0,
        },
        domainCount: 1,
        terminalDomainCount: 0,
      },
    ],
    reviews: [],
  };
}

function makeVisibleSession(
  state: UltraPlanSessionSummary["state"],
  bucket: UltraPlanVisibleSession["bucket"],
  title: string,
  idleReasonLabel: string | null,
): UltraPlanVisibleSession {
  return {
    ...makeSummary(state, title, idleReasonLabel ?? undefined),
    bucket,
    idleReasonLabel,
  };
}

const resolved: UltraPlanResolvedCursor = {
  source: "recomputed",
  cursor: currentCursor,
};

describe("ultraplan presenter", () => {
  test("formats pending, ongoing, and idle picker labels and omits done sessions from the default picker set", () => {
    const options = buildUltraPlanPickerOptions([
      makeVisibleSession("ready", "pending", "Pending session", null),
      makeVisibleSession("running", "ongoing", "Ongoing session", null),
      makeVisibleSession("blocked", "idle", "Idle session", "Need product sign-off"),
    ]);

    expect(options).toEqual([
      {
        value: "pending-session",
        label: "[pending] Pending session",
        description: "Current: frontend / auth / unit / Second scenario",
      },
      {
        value: "ongoing-session",
        label: "[ongoing] Ongoing session",
        description: "Current: frontend / auth / unit / Second scenario",
      },
      {
        value: "idle-session",
        label: "[idle] Idle session",
        description: "Idle: Need product sign-off",
      },
    ]);
  });

  test("renders status with bucket, current cursor, last completed unit, stack/domain progress, and next action", () => {
    const session = makeSummary("running", "Auth slice");

    expect(renderUltraPlanStatus(session, authored, resolved)).toBe([
      "Title: Auth slice",
      "Goal: Ship authentication",
      "State: running",
      "Bucket: ongoing",
      "Current: frontend / auth / unit / Second scenario",
      "Current source: recomputed",
      "Last completed (persisted): frontend / auth / unit / First scenario",
      "Stack progress (persisted): frontend 0/1 domains terminal",
      "Domain progress: auth 1/2 scenarios terminal",
      "Next action: Resume frontend / auth / unit / Second scenario",
    ].join("\n"));
  });

  test("renders blocker details for idle sessions", () => {
    const session = makeSummary("awaiting-user", "Idle auth slice", "Need product sign-off");

    expect(renderUltraPlanStatus(session, authored, resolved)).toContain("Idle reason: Awaiting user: Need product sign-off");
  });
});


// ---------------------------------------------------------------------------
// Slice-2 blocker surfacing (migration-unsafe, migration-conflict, interrupted-attempt)
// ---------------------------------------------------------------------------

function makeSummaryWithBlocker(
  state: UltraPlanSessionSummary["state"],
  title: string,
  blocker: UltraPlanSessionSummary["blocker"],
): UltraPlanSessionSummary {
  const base = makeSummary(state, title);
  return { ...base, blocker, progress: { ...base.progress, blocked: blocker ? 1 : 0 } };
}

describe("ultraplan presenter — slice-2 blocker surfacing", () => {
  test("renderUltraPlanStatus surfaces migration-unsafe recovery metadata", () => {
    const session = makeSummaryWithBlocker("blocked", "Broken session", {
      code: "migration-unsafe",
      message: "legacy manifest failed validation",
      scope: "session",
      affected: { stack: null, domainId: null, level: null, scenarioId: null },
      recoverable: true,
      recoveryMode: "manual",
      nextAction: "Inspect /abs/legacy and repair manually",
      retryable: false,
      detectedAt: "2026-04-20T12:00:00.000Z",
    });
    const output = renderUltraPlanStatus(session, authored, resolved);
    expect(output).toContain("Blocker: migration-unsafe");
    expect(output).toContain("Recovery: manual");
    expect(output).toContain("Inspect /abs/legacy and repair manually");
  });

  test("renderUltraPlanStatus surfaces migration-conflict recovery metadata", () => {
    const session = makeSummaryWithBlocker("blocked", "Conflicted session", {
      code: "migration-conflict",
      message: "legacy and global differ",
      scope: "session",
      affected: { stack: null, domainId: null, level: null, scenarioId: null },
      recoverable: true,
      recoveryMode: "manual",
      nextAction: "Decide which side is canonical",
      retryable: false,
      detectedAt: "2026-04-20T12:00:00.000Z",
    });
    const output = renderUltraPlanStatus(session, authored, resolved);
    expect(output).toContain("Blocker: migration-conflict");
    expect(output).toContain("Decide which side is canonical");
  });

  test("renderUltraPlanStatus surfaces interrupted-attempt recovery metadata", () => {
    const session = makeSummaryWithBlocker("blocked", "Interrupted session", {
      code: "interrupted-attempt",
      message: "attempt att-001 was interrupted",
      scope: "scenario",
      affected: { stack: "frontend", domainId: "auth", level: "unit", scenarioId: "scenario-b" },
      recoverable: true,
      recoveryMode: "retry",
      nextAction: "Retry the attempt with a fresh launch",
      retryable: true,
      detectedAt: "2026-04-19T12:30:00.000Z",
    });
    const output = renderUltraPlanStatus(session, authored, resolved);
    expect(output).toContain("Blocker: interrupted-attempt");
    expect(output).toContain("Recovery: retry");
  });

  test("buildUltraPlanPickerOptions surfaces blocker code and recovery for slice-2 blockers", () => {
    const visible = {
      ...makeSummaryWithBlocker("blocked", "Conflicted session", {
        code: "migration-conflict",
        message: "conflict",
        scope: "session",
        affected: { stack: null, domainId: null, level: null, scenarioId: null },
        recoverable: true,
        recoveryMode: "manual",
        nextAction: "Decide canonical side",
        retryable: false,
        detectedAt: "2026-04-20T12:00:00.000Z",
      }),
      bucket: "idle" as const,
      idleReasonLabel: "Blocked: conflict",
    };
    const [opt] = buildUltraPlanPickerOptions([visible]);
    expect(opt.description).toContain("migration-conflict");
    expect(opt.description).toContain("manual");
  });
});