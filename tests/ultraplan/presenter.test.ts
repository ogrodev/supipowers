import { describe, expect, test } from "bun:test";
import type { UltraPlanCursor, UltraPlanSessionSummary } from "../../src/types.js";
import type { UltraPlanResolvedCursor, UltraPlanVisibleSession } from "../../src/ultraplan/session-selection.js";
import { buildUltraPlanPickerOptions, renderUltraPlanStatus } from "../../src/ultraplan/presenter.js";
import { makeCatalogFixture, makeUltraPlanAuthored, makeUltraPlanScenario, makeUltraPlanStack } from "./fixtures.js";

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

import {
  addDomain,
  addScenario,
  buildInitialAuthoredDraft,
  setStackApplicability,
} from "../../src/ultraplan/authoring-draft.js";
import { renderUltraPlanAuthoredDraft } from "../../src/ultraplan/presenter.js";
const RENDER_CREATED_AT = new Date("2026-04-21T12:00:00.000Z");

function must<T>(r: { ok: true; draft: T } | { ok: false; reason: unknown }): T {
  if (!r.ok) throw new Error("expected ok");
  return r.draft;
}


describe("renderUltraPlanAuthoredDraft", () => {
  test("renders frontend populated, backend empty-domain, infrastructure not-applicable", () => {
    let draft = buildInitialAuthoredDraft({
      sessionId: "up-render-1",
      title: "Checkout redesign",
      goal: "Users can complete checkout on mobile",
      createdAt: RENDER_CREATED_AT,
      catalog: makeCatalogFixture(),
    });
    // frontend: auth domain + 1 scenario per level
    const r1 = addDomain(draft, "frontend", { id: "auth", name: "Authentication" });
    draft = must(r1);
    const r2 = addScenario(draft, { stack: "frontend", domainId: "auth", level: "unit" }, { id: "login", title: "Login renders" });
    draft = must(r2);
    const r3 = addScenario(draft, { stack: "frontend", domainId: "auth", level: "integration" }, { id: "flow", title: "Login flow completes" });
    draft = must(r3);
    const r4 = addScenario(draft, { stack: "frontend", domainId: "auth", level: "e2e" }, { id: "e2e-login", title: "End-to-end login" });
    draft = must(r4);
    // backend: 1 empty domain (non-persist-ready but must still render)
    const r5 = addDomain(draft, "backend", { id: "profiles", name: "Profiles" });
    draft = must(r5);
    // infrastructure: not-applicable
    const r6 = setStackApplicability(draft, "infrastructure", "not-applicable");
    draft = must(r6);

    const EXPECTED = [
      "Session: Checkout redesign",
      "Goal: Users can complete checkout on mobile",
      "",
      "## frontend (applicable)",
      "  executor: frontend-executor",
      "  tester: frontend-tester",
      "  domain reviewer: frontend-domain-reviewer",
      "  stack reviewer: frontend-stack-reviewer",
      "",
      "  Domain: auth — Authentication",
      "    unit:",
      "      - login: Login renders",
      "    integration:",
      "      - flow: Login flow completes",
      "    e2e:",
      "      - e2e-login: End-to-end login",
      "",
      "## backend (applicable)",
      "  executor: backend-executor",
      "  tester: backend-tester",
      "  domain reviewer: backend-domain-reviewer",
      "  stack reviewer: backend-stack-reviewer",
      "",
      "  Domain: profiles — Profiles",
      "    unit: —",
      "    integration: —",
      "    e2e: —",
      "",
      "## infrastructure (not-applicable)",
      "",
      "Readiness blockers:",
      "  - backend.profiles has no scenarios (edit backend.profiles.scenarios)",
    ].join("\n");

    expect(renderUltraPlanAuthoredDraft(draft).join("\n")).toBe(EXPECTED);
  });
});

describe("renderUltraPlanAuthoredDraft — edge cases", () => {
  test("all three stacks not-applicable renders header lines only and readiness blocker", () => {
    let draft = buildInitialAuthoredDraft({
      sessionId: "up-all-na",
      title: "Empty",
      goal: "Nothing",
      createdAt: RENDER_CREATED_AT,
      catalog: makeCatalogFixture(),
    });
    draft = must(setStackApplicability(draft, "frontend", "not-applicable"));
    draft = must(setStackApplicability(draft, "backend", "not-applicable"));
    draft = must(setStackApplicability(draft, "infrastructure", "not-applicable"));

    const out = renderUltraPlanAuthoredDraft(draft).join("\n");
    // Session title + goal block
    expect(out).toContain("Session: Empty");
    expect(out).toContain("Goal: Nothing");
    // Three header-only not-applicable lines
    expect(out).toContain("## frontend (not-applicable)");
    expect(out).toContain("## backend (not-applicable)");
    expect(out).toContain("## infrastructure (not-applicable)");
    // Readiness block
    expect(out).toContain("Readiness blockers:");
    expect(out).toContain("No applicable stacks");
  });

  test("omits reviewer lines when reviewer gates disable those bindings", () => {
    let draft = buildInitialAuthoredDraft({
      sessionId: "up-no-reviewers",
      title: "No reviewers",
      goal: "x",
      createdAt: RENDER_CREATED_AT,
      catalog: makeCatalogFixture({
        reviewGates: {
          "frontend-domain-reviewer": { enabled: false },
          "frontend-stack-reviewer": { enabled: false },
        },
        slotNulls: ["frontend-domain-reviewer", "frontend-stack-reviewer"],
      }),
    });
    draft = must(setStackApplicability(draft, "backend", "not-applicable"));
    draft = must(setStackApplicability(draft, "infrastructure", "not-applicable"));
    draft = must(addDomain(draft, "frontend", { id: "auth", name: "Auth" }));
    draft = must(addScenario(draft, { stack: "frontend", domainId: "auth", level: "unit" }, { id: "login", title: "Login" }));

    const out = renderUltraPlanAuthoredDraft(draft).join("\n");
    expect(out).toContain("  executor: frontend-executor");
    expect(out).toContain("  tester: frontend-tester");
    expect(out).not.toContain("domain reviewer:");
    expect(out).not.toContain("stack reviewer:");
    expect(out).not.toContain("Readiness blockers:");
  });

  test("empty unit[] + populated integration[] renders unit em-dash then integration scenarios", () => {
    let draft = buildInitialAuthoredDraft({
      sessionId: "up-int",
      title: "Mix",
      goal: "x",
      createdAt: RENDER_CREATED_AT,
      catalog: makeCatalogFixture(),
    });
    draft = must(setStackApplicability(draft, "backend", "not-applicable"));
    draft = must(setStackApplicability(draft, "infrastructure", "not-applicable"));
    draft = must(addDomain(draft, "frontend", { id: "auth", name: "Auth" }));
    draft = must(addScenario(draft, { stack: "frontend", domainId: "auth", level: "integration" }, { id: "flow", title: "Login flow" }));
    const out = renderUltraPlanAuthoredDraft(draft).join("\n");
    expect(out).toContain("    unit: —");
    expect(out).toContain("    integration:");
    expect(out).toContain("      - flow: Login flow");
    expect(out).toContain("    e2e: —");
    // Persist-ready; no blocker section
    expect(out).not.toContain("Readiness blockers:");
  });

  test("non-ready draft appends readiness blockers section with targeted edit label", () => {
    let draft = buildInitialAuthoredDraft({
      sessionId: "up-blocker",
      title: "Blocked",
      goal: "x",
      createdAt: RENDER_CREATED_AT,
      catalog: makeCatalogFixture(),
    });
    draft = must(setStackApplicability(draft, "backend", "not-applicable"));
    draft = must(setStackApplicability(draft, "infrastructure", "not-applicable"));
    draft = must(addDomain(draft, "frontend", { id: "auth", name: "Auth" }));
    // No scenarios → empty-domain blocker
    const out = renderUltraPlanAuthoredDraft(draft).join("\n");
    expect(out).toContain("Readiness blockers:");
    expect(out).toContain("edit frontend.auth.scenarios");
  });
});