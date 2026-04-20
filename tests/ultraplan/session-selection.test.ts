import { describe, expect, test } from "bun:test";
import type {
  UltraPlanAuthoredArtifact,
  UltraPlanBlocker,
  UltraPlanCursor,
  UltraPlanManifest,
  UltraPlanSessionState,
  UltraPlanSessionSummary,
  UltraPlanStack,
  UltraPlanStackId,
} from "../../src/types.js";
import {
  getUltraPlanIdleReasonLabel,
  getVisibleUltraPlanSessions,
  isUltraPlanCursorSummaryValid,
  mapUltraPlanStateToBucket,
  resolveUltraPlanCurrentCursor,
} from "../../src/ultraplan/session-selection.js";
import {
  makeUltraPlanAuthored,
  makeUltraPlanManifest,
  makeUltraPlanProof,
  makeUltraPlanScenario,
  makeUltraPlanStack,
} from "./fixtures.js";

const makeProof = makeUltraPlanProof;
const makeScenario = makeUltraPlanScenario;

function makeStack(overrides?: Partial<UltraPlanStack>): UltraPlanStack {
  return makeUltraPlanStack({
    domains: [
      {
        id: "auth",
        name: "Authentication",
        unit: [makeScenario("a", "First scenario", "planned"), makeScenario("b", "Second scenario", "planned")],
        integration: [],
        e2e: [],
        review: { enabled: true, status: "pending" },
        progress: { total: 2, terminal: 0, blocked: 0 },
      },
    ],
    ...overrides,
  });
}

function makeAuthored(stacks: UltraPlanStack[]): UltraPlanAuthoredArtifact {
  return makeUltraPlanAuthored({ stacks });
}

function makeManifest(overrides?: Partial<UltraPlanManifest>): UltraPlanManifest {
  return makeUltraPlanManifest(overrides);
}

function makeSummary(state: UltraPlanSessionState, blocker: UltraPlanBlocker | null = null): UltraPlanSessionSummary {
  return {
    sessionId: `${state}-session`,
    projectName: "supipowers",
    title: `${state} session`,
    state,
    createdAt: "2026-04-19T12:00:00.000Z",
    updatedAt: "2026-04-19T12:15:00.000Z",
    cursor: null,
    lastCompleted: null,
    blocker,
    progress: {
      total: 2,
      terminal: 0,
      blocked: state === "blocked" || state === "awaiting-user" ? 1 : 0,
    },
    stacks: [],
    reviews: [],
  };
}

function blocker(message: string): UltraPlanBlocker {
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
    recoverable: true,
    recoveryMode: "await-user",
    nextAction: "Wait for input",
    retryable: false,
    detectedAt: "2026-04-19T12:10:00.000Z",
  };
}

describe("ultraplan session selection", () => {
  test("maps internal session states to picker buckets", () => {
    expect(mapUltraPlanStateToBucket("ready")).toBe("pending");
    expect(mapUltraPlanStateToBucket("running")).toBe("ongoing");
    expect(mapUltraPlanStateToBucket("blocked")).toBe("idle");
    expect(mapUltraPlanStateToBucket("awaiting-user")).toBe("idle");
    expect(mapUltraPlanStateToBucket("complete")).toBe("done");
    expect(mapUltraPlanStateToBucket("discarded")).toBe("done");
  });

  test("hides done sessions by default and exposes them when requested", () => {
    const sessions = [
      makeSummary("ready"),
      makeSummary("running"),
      makeSummary("blocked", blocker("Need API key")),
      makeSummary("complete"),
      makeSummary("discarded"),
    ];

    expect(getVisibleUltraPlanSessions(sessions).map((session) => session.sessionId)).toEqual([
      "ready-session",
      "running-session",
      "blocked-session",
    ]);
    expect(getVisibleUltraPlanSessions(sessions, { includeDone: true }).map((session) => session.sessionId)).toEqual([
      "ready-session",
      "running-session",
      "blocked-session",
      "complete-session",
      "discarded-session",
    ]);
  });

  test("renders idle reason labels from blocker data and awaiting-user state", () => {
    expect(getUltraPlanIdleReasonLabel(makeSummary("blocked", blocker("Need API key")))).toBe("Need API key");
    expect(getUltraPlanIdleReasonLabel(makeSummary("awaiting-user", blocker("Need product sign-off")))).toBe(
      "Awaiting user: Need product sign-off",
    );
  });

  test("recognizes a valid persisted cursor summary", () => {
    const authored = makeAuthored([makeStack()]);
    const cursor: UltraPlanCursor = {
      targetType: "scenario",
      stack: "frontend",
      domainId: "auth",
      level: "unit",
      scenarioId: "a",
      phase: "red",
      status: "planned",
      summary: "frontend / auth / unit / First scenario",
    };
    const manifest = makeManifest({ cursor });

    expect(isUltraPlanCursorSummaryValid(manifest, authored)).toBe(true);
    expect(resolveUltraPlanCurrentCursor(manifest, authored)).toEqual({
      cursor,
      source: "persisted",
    });
  });
  test("recomputes a stale summary even when the persisted cursor identity still matches", () => {
    const authored = makeAuthored([makeStack()]);
    const manifest = makeManifest({
      cursor: {
        targetType: "scenario",
        stack: "frontend",
        domainId: "auth",
        level: "unit",
        scenarioId: "a",
        phase: "red",
        status: "planned",
        summary: "stale summary",
      },
    });

    expect(isUltraPlanCursorSummaryValid(manifest, authored)).toBe(false);
    expect(resolveUltraPlanCurrentCursor(manifest, authored)).toEqual({
      source: "recomputed",
      cursor: {
        targetType: "scenario",
        stack: "frontend",
        domainId: "auth",
        level: "unit",
        scenarioId: "a",
        phase: "red",
        status: "planned",
        summary: "frontend / auth / unit / First scenario",
      },
    });
  });



  test("recomputes the next scenario from persisted order when the cursor is missing or stale", () => {
    const authored = makeAuthored([
      makeStack({
        domains: [
          {
            id: "auth",
            name: "Authentication",
            unit: [makeScenario("a", "First scenario", "green-proved"), makeScenario("b", "Second scenario", "planned")],
            integration: [],
            e2e: [],
            review: { enabled: true, status: "pending" },
            progress: { total: 2, terminal: 1, blocked: 0 },
          },
        ],
      }),
    ]);
    const staleManifest = makeManifest({
      cursor: {
        targetType: "scenario",
        stack: "frontend",
        domainId: "auth",
        level: "unit",
        scenarioId: "a",
        phase: "green",
        status: "green-proved",
        summary: "stale summary",
      },
    });

    expect(isUltraPlanCursorSummaryValid(staleManifest, authored)).toBe(false);
    expect(resolveUltraPlanCurrentCursor(staleManifest, authored)).toEqual({
      source: "recomputed",
      cursor: {
        targetType: "scenario",
        stack: "frontend",
        domainId: "auth",
        level: "unit",
        scenarioId: "b",
        phase: "red",
        status: "planned",
        summary: "frontend / auth / unit / Second scenario",
      },
    });
  });
  test("treats terminal scenarios without required proofs as incomplete work", () => {
    const authored = makeAuthored([
      makeStack({
        domains: [
          {
            id: "auth",
            name: "Authentication",
            unit: [{ ...makeScenario("a", "First scenario", "done"), proofs: [] }],
            integration: [],
            e2e: [],
            review: { enabled: true, status: "pending" },
            progress: { total: 1, terminal: 1, blocked: 0 },
          },
        ],
      }),
    ]);

    expect(resolveUltraPlanCurrentCursor(makeManifest(), authored)).toEqual({
      source: "recomputed",
      cursor: {
        targetType: "scenario",
        stack: "frontend",
        domainId: "auth",
        level: "unit",
        scenarioId: "a",
        phase: "complete",
        status: "done",
        summary: "frontend / auth / unit / First scenario",
      },
    });
  });
  test("treats terminal scenarios with the wrong proof type as incomplete work", () => {
    const authored = makeAuthored([
      makeStack({
        domains: [
          {
            id: "auth",
            name: "Authentication",
            unit: [
              {
                ...makeScenario("a", "First scenario", "green-proved"),
                proofs: [{ ...makeProof("green"), type: "artifact" }],
              },
              makeScenario("b", "Second scenario", "planned"),
            ],
            integration: [],
            e2e: [],
            review: { enabled: true, status: "pending" },
            progress: { total: 2, terminal: 1, blocked: 0 },
          },
        ],
      }),
    ]);

    expect(resolveUltraPlanCurrentCursor(makeManifest(), authored)).toEqual({
      source: "recomputed",
      cursor: {
        targetType: "scenario",
        stack: "frontend",
        domainId: "auth",
        level: "unit",
        scenarioId: "a",
        phase: "complete",
        status: "green-proved",
        summary: "frontend / auth / unit / First scenario",
      },
    });
  });

  test("advances past done scenarios backed by carried-forward terminal proofs", () => {
    const authored = makeAuthored([
      makeStack({
        domains: [
          {
            id: "auth",
            name: "Authentication",
            unit: [
              {
                ...makeScenario("a", "First scenario", "done"),
                proofs: [makeProof("green")],
              },
              makeScenario("b", "Second scenario", "planned"),
            ],
            integration: [],
            e2e: [],
            review: { enabled: true, status: "pending" },
            progress: { total: 2, terminal: 1, blocked: 0 },
          },
        ],
      }),
    ]);

    expect(resolveUltraPlanCurrentCursor(makeManifest(), authored)).toEqual({
      source: "recomputed",
      cursor: {
        targetType: "scenario",
        stack: "frontend",
        domainId: "auth",
        level: "unit",
        scenarioId: "b",
        phase: "red",
        status: "planned",
        summary: "frontend / auth / unit / Second scenario",
      },
    });
  });





  test("elevates to the domain reviewer when all scenarios in a domain are terminal", () => {
    const authored = makeAuthored([
      makeStack({
        domains: [
          {
            id: "auth",
            name: "Authentication",
            unit: [makeScenario("a", "First scenario", "done")],
            integration: [],
            e2e: [],
            review: { enabled: true, status: "pending" },
            progress: { total: 1, terminal: 1, blocked: 0 },
          },
        ],
      }),
    ]);

    expect(resolveUltraPlanCurrentCursor(makeManifest(), authored)).toEqual({
      source: "recomputed",
      cursor: {
        targetType: "domain-review",
        stack: "frontend",
        domainId: "auth",
        level: null,
        scenarioId: null,
        phase: "review",
        status: "pending",
        summary: "frontend / auth / domain review",
      },
    });
  });

  test("elevates to the stack reviewer when all domains are terminal", () => {
    const authored = makeAuthored([
      makeStack({
        domains: [
          {
            id: "auth",
            name: "Authentication",
            unit: [makeScenario("a", "First scenario", "done")],
            integration: [],
            e2e: [],
            review: { enabled: true, status: "passed" },
            progress: { total: 1, terminal: 1, blocked: 0 },
          },
        ],
      }),
    ]);
    const manifest = makeManifest({
      reviews: [
        {
          type: "domain",
          stack: "frontend",
          domainId: "auth",
          path: "review/frontend/domains/auth.json",
          status: "passed",
        },
      ],
    });

    expect(resolveUltraPlanCurrentCursor(manifest, authored)).toEqual({
      source: "recomputed",
      cursor: {
        targetType: "stack-review",
        stack: "frontend",
        domainId: null,
        level: null,
        scenarioId: null,
        phase: "review",
        status: "pending",
        summary: "frontend / stack review",
      },
    });
  });

  test("marks the session complete when all applicable stacks are terminal", () => {
    const authored = makeAuthored([
      makeStack({
        domains: [
          {
            id: "auth",
            name: "Authentication",
            unit: [makeScenario("a", "First scenario", "done")],
            integration: [],
            e2e: [],
            review: { enabled: true, status: "passed" },
            progress: { total: 1, terminal: 1, blocked: 0 },
          },
        ],
        progress: { total: 1, terminal: 1, blocked: 0 },
      }),
      {
        ...makeStack({ stack: "backend" as UltraPlanStackId }),
        applicability: "not-applicable",
        domains: [],
        progress: { total: 0, terminal: 0, blocked: 0 },
      },
    ]);
    const manifest = makeManifest({
      reviews: [
        {
          type: "domain",
          stack: "frontend",
          domainId: "auth",
          path: "review/frontend/domains/auth.json",
          status: "passed",
        },
        {
          type: "stack",
          stack: "frontend",
          domainId: null,
          path: "review/frontend/stack.json",
          status: "passed",
        },
      ],
    });

    expect(resolveUltraPlanCurrentCursor(manifest, authored)).toEqual({
      source: "recomputed",
      cursor: {
        targetType: "session",
        stack: null,
        domainId: null,
        level: null,
        scenarioId: null,
        phase: "complete",
        status: "complete",
        summary: "Session complete",
      },
    });
  });

  test("advances past disabled review gates only when they are explicitly disabled", () => {
    const authored = makeAuthored([
      makeStack({
        domains: [
          {
            id: "auth",
            name: "Authentication",
            unit: [makeScenario("a", "First scenario", "done")],
            integration: [],
            e2e: [],
            review: { enabled: false, status: "pending" },
            progress: { total: 1, terminal: 1, blocked: 0 },
          },
        ],
        agentSlots: {
          ...makeStack().agentSlots,
          domainReviewEnabled: false,
          stackReviewEnabled: false,
          domainReviewer: undefined,
          stackReviewer: undefined,
        },
      }),
    ]);

    expect(resolveUltraPlanCurrentCursor(makeManifest(), authored)).toEqual({
      source: "recomputed",
      cursor: {
        targetType: "session",
        stack: null,
        domainId: null,
        level: null,
        scenarioId: null,
        phase: "complete",
        status: "complete",
        summary: "Session complete",
      },
    });
  });
  test("skips domain review when the domain disables it even if the stack-level feature is enabled", () => {
    const authored = makeAuthored([
      makeStack({
        domains: [
          {
            id: "auth",
            name: "Authentication",
            unit: [makeScenario("a", "First scenario", "done")],
            integration: [],
            e2e: [],
            review: { enabled: false, status: "pending" },
            progress: { total: 1, terminal: 1, blocked: 0 },
          },
        ],
        agentSlots: {
          ...makeStack().agentSlots,
          stackReviewEnabled: false,
          stackReviewer: undefined,
        },
      }),
    ]);

    expect(resolveUltraPlanCurrentCursor(makeManifest(), authored)).toEqual({
      source: "recomputed",
      cursor: {
        targetType: "session",
        stack: null,
        domainId: null,
        level: null,
        scenarioId: null,
        phase: "complete",
        status: "complete",
        summary: "Session complete",
      },
    });
  });



  test("refuses to advance when a required reviewer slot is missing", () => {
    const authored = makeAuthored([
      makeStack({
        domains: [
          {
            id: "auth",
            name: "Authentication",
            unit: [makeScenario("a", "First scenario", "done")],
            integration: [],
            e2e: [],
            review: { enabled: true, status: "pending" },
            progress: { total: 1, terminal: 1, blocked: 0 },
          },
        ],
        agentSlots: {
          ...makeStack().agentSlots,
          domainReviewer: undefined,
        },
      }),
    ]);

    expect(resolveUltraPlanCurrentCursor(makeManifest(), authored)).toEqual({
      source: "recomputed",
      cursor: {
        targetType: "domain-review",
        stack: "frontend",
        domainId: "auth",
        level: null,
        scenarioId: null,
        phase: "waiting",
        status: "blocked",
        summary: "frontend / auth / domain review blocked — missing reviewer slot",
      },
    });
  });
});
