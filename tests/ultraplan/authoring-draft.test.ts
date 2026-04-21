import { describe, expect, test } from "bun:test";
import type {
  UltraPlanAgentSlotName,
  UltraPlanStackId,
} from "../../src/types.js";
import { isUltraPlanAuthoredArtifact } from "../../src/ultraplan/contracts.js";
import {
  addDomain,
  addScenario,
  buildInitialAuthoredDraft,
  draftToAuthoredArtifact,
  draftToIndexEntry,
  draftToManifest,
  initialCursor,
  isDraftReadyToPersist,
  removeDomain,
  removeScenario,
  renameDomain,
  renameScenario,
  setSessionId,
  setSessionTitleAndGoal,
  setStackApplicability,
} from "../../src/ultraplan/authoring-draft.js";

import { makeCatalogFixture } from "./fixtures.js";

describe("authoring-draft module exports", () => {
  test("every exported operation is defined at module load", () => {
    expect(typeof buildInitialAuthoredDraft).toBe("function");
    expect(typeof setSessionTitleAndGoal).toBe("function");
    expect(typeof setSessionId).toBe("function");
    expect(typeof setStackApplicability).toBe("function");
    expect(typeof addDomain).toBe("function");
    expect(typeof renameDomain).toBe("function");
    expect(typeof removeDomain).toBe("function");
    expect(typeof addScenario).toBe("function");
    expect(typeof renameScenario).toBe("function");
    expect(typeof removeScenario).toBe("function");
    expect(typeof draftToAuthoredArtifact).toBe("function");
    expect(typeof draftToManifest).toBe("function");
    expect(typeof draftToIndexEntry).toBe("function");
    expect(typeof initialCursor).toBe("function");
    expect(typeof isDraftReadyToPersist).toBe("function");
  });
});

const CREATED_AT = new Date("2026-04-21T12:00:00.000Z");

describe("buildInitialAuthoredDraft — happy path + projection", () => {
  test("builds three-stack triad in fixed frontend/backend/infrastructure order", () => {
    const draft = buildInitialAuthoredDraft({
      sessionId: "up-test",
      title: "t",
      goal: "g",
      createdAt: CREATED_AT,
      catalog: makeCatalogFixture(),
    });

    expect(draft.stacks).toHaveLength(3);
    expect(draft.stacks.map((s) => s.stack)).toEqual([
      "frontend",
      "backend",
      "infrastructure",
    ]);
  });

  test("every stack starts applicable/ready/empty with zero progress", () => {
    const draft = buildInitialAuthoredDraft({
      sessionId: "up-test",
      title: "t",
      goal: "g",
      createdAt: CREATED_AT,
      catalog: makeCatalogFixture(),
    });

    for (const stack of draft.stacks) {
      expect(stack.applicability).toBe("applicable");
      expect(stack.status).toBe("ready");
      expect(stack.domains).toEqual([]);
      expect(stack.progress).toEqual({ total: 0, terminal: 0, blocked: 0 });
    }
  });

  test("agentSlots projects executor + tester always present, reviewers gated by reviewGates default", () => {
    const draft = buildInitialAuthoredDraft({
      sessionId: "up-test",
      title: "t",
      goal: "g",
      createdAt: CREATED_AT,
      catalog: makeCatalogFixture(),
    });

    for (const stack of draft.stacks) {
      expect(stack.agentSlots.executor.slot).toBe(`${stack.stack}-executor`);
      expect(stack.agentSlots.tester.slot).toBe(`${stack.stack}-tester`);
      // Default-enabled (no gate override) → reviewers present
      expect(stack.agentSlots.domainReviewEnabled).toBe(true);
      expect(stack.agentSlots.stackReviewEnabled).toBe(true);
      expect(stack.agentSlots.domainReviewer?.slot).toBe(`${stack.stack}-domain-reviewer`);
      expect(stack.agentSlots.stackReviewer?.slot).toBe(`${stack.stack}-stack-reviewer`);
    }
  });

  test("agentSlots strips reviewer bindings when gate disabled", () => {
    const draft = buildInitialAuthoredDraft({
      sessionId: "up-test",
      title: "t",
      goal: "g",
      createdAt: CREATED_AT,
      catalog: makeCatalogFixture({
        reviewGates: {
          "frontend-domain-reviewer": { enabled: false },
          "backend-stack-reviewer": { enabled: false },
        },
      }),
    });

    const frontend = draft.stacks.find((s) => s.stack === "frontend")!;
    expect(frontend.agentSlots.domainReviewEnabled).toBe(false);
    expect(frontend.agentSlots.domainReviewer).toBeUndefined();
    expect(frontend.agentSlots.stackReviewEnabled).toBe(true);
    expect(frontend.agentSlots.stackReviewer?.slot).toBe("frontend-stack-reviewer");

    const backend = draft.stacks.find((s) => s.stack === "backend")!;
    expect(backend.agentSlots.stackReviewEnabled).toBe(false);
    expect(backend.agentSlots.stackReviewer).toBeUndefined();
    expect(backend.agentSlots.domainReviewer?.slot).toBe("backend-domain-reviewer");
  });

  test("projected agentBinding carries only canonical fields (no provenance leaks)", () => {
    const draft = buildInitialAuthoredDraft({
      sessionId: "up-test",
      title: "t",
      goal: "g",
      createdAt: CREATED_AT,
      catalog: makeCatalogFixture(),
    });

    for (const stack of draft.stacks) {
      const binding = stack.agentSlots.executor;
      expect(Object.keys(binding).sort()).toEqual(
        ["slot", "agentType", "agentName", "model", "thinkingLevel"].sort(),
      );
      expect(binding.agentName).toBe(`${stack.stack}-executor`);
    }
  });

  test("constructed draft satisfies isUltraPlanAuthoredArtifact", () => {
    const draft = buildInitialAuthoredDraft({
      sessionId: "up-test",
      title: "An example title",
      goal: "Ship the things",
      createdAt: CREATED_AT,
      catalog: makeCatalogFixture(),
    });

    expect(isUltraPlanAuthoredArtifact(draft)).toBe(true);
  });

  test("session fields are copied onto the draft", () => {
    const draft = buildInitialAuthoredDraft({
      sessionId: "up-42",
      title: "Checkout redesign",
      goal: "Users can complete checkout on mobile",
      createdAt: CREATED_AT,
      catalog: makeCatalogFixture(),
    });

    expect(draft.sessionId).toBe("up-42");
    expect(draft.title).toBe("Checkout redesign");
    expect(draft.goal).toBe("Users can complete checkout on mobile");
    expect(draft.createdAt).toBe(CREATED_AT.toISOString());
    expect(draft.updatedAt).toBe(CREATED_AT.toISOString());
  });
});

describe("buildInitialAuthoredDraft — defensive preconditions", () => {
  test("empty title throws", () => {
    expect(() => buildInitialAuthoredDraft({
      sessionId: "up-test",
      title: "",
      goal: "g",
      createdAt: CREATED_AT,
      catalog: makeCatalogFixture(),
    })).toThrow();
  });

  test("empty goal throws", () => {
    expect(() => buildInitialAuthoredDraft({
      sessionId: "up-test",
      title: "t",
      goal: "",
      createdAt: CREATED_AT,
      catalog: makeCatalogFixture(),
    })).toThrow();
  });

  test("null frontend-executor slot throws", () => {
    expect(() => buildInitialAuthoredDraft({
      sessionId: "up-test",
      title: "t",
      goal: "g",
      createdAt: CREATED_AT,
      catalog: makeCatalogFixture({ slotNulls: ["frontend-executor"] }),
    })).toThrow(/frontend-executor/);
  });

  test("null backend-tester slot throws", () => {
    expect(() => buildInitialAuthoredDraft({
      sessionId: "up-test",
      title: "t",
      goal: "g",
      createdAt: CREATED_AT,
      catalog: makeCatalogFixture({ slotNulls: ["backend-tester"] }),
    })).toThrow(/backend-tester/);
  });

  test("null frontend-domain-reviewer with enabled gate throws", () => {
    expect(() => buildInitialAuthoredDraft({
      sessionId: "up-test",
      title: "t",
      goal: "g",
      createdAt: CREATED_AT,
      catalog: makeCatalogFixture({
        reviewGates: { "frontend-domain-reviewer": { enabled: true } },
        slotNulls: ["frontend-domain-reviewer"],
      }),
    })).toThrow(/frontend-domain-reviewer/);
  });
});

function baseDraft() {
  return buildInitialAuthoredDraft({
    sessionId: "up-test",
    title: "t",
    goal: "g",
    createdAt: CREATED_AT,
    catalog: makeCatalogFixture(),
  });
}

function expectOk<T extends { ok: true; draft: unknown } | { ok: false; reason: unknown }>(r: T): T & { ok: true } {
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("expected ok");
  return r as T & { ok: true };
}

function expectFail<T extends { ok: true; draft: unknown } | { ok: false; reason: unknown }>(r: T): T & { ok: false } {
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error("expected fail");
  return r as T & { ok: false };
}

describe("setSessionTitleAndGoal + setSessionId", () => {
  test("title-only patch updates title, leaves goal", () => {
    const draft = baseDraft();
    const result = expectOk(setSessionTitleAndGoal(draft, { title: "new title" }));
    expect(result.draft.title).toBe("new title");
    expect(result.draft.goal).toBe("g");
  });

  test("over-cap title (81 chars) returns length-cap error", () => {
    const draft = baseDraft();
    const over = "a".repeat(81);
    const result = expectFail(setSessionTitleAndGoal(draft, { title: over }));
    expect(result.reason).toEqual({ code: "length-cap", field: "title", max: 80, got: 81 });
  });

  test("empty-string title returns length-cap error with got: 0", () => {
    const draft = baseDraft();
    const result = expectFail(setSessionTitleAndGoal(draft, { title: "" }));
    expect(result.reason).toEqual({ code: "length-cap", field: "title", max: 80, got: 0 });
  });

  test("over-cap goal (281 chars) returns length-cap error", () => {
    const draft = baseDraft();
    const over = "a".repeat(281);
    const result = expectFail(setSessionTitleAndGoal(draft, { goal: over }));
    expect(result.reason).toEqual({ code: "length-cap", field: "goal", max: 280, got: 281 });
  });

  test("setSessionId updates sessionId", () => {
    const draft = baseDraft();
    const result = expectOk(setSessionId(draft, "new-id"));
    expect(result.draft.sessionId).toBe("new-id");
  });

  test("empty setSessionId rejected", () => {
    const draft = baseDraft();
    const result = expectFail(setSessionId(draft, ""));
    expect(result.reason.code).toBe("length-cap");
  });
});



// Silence "unused import" warnings for operations covered in later tasks.
void [
  addDomain,
  addScenario,
  draftToAuthoredArtifact,
  draftToIndexEntry,
  draftToManifest,
  initialCursor,
  isDraftReadyToPersist,
  removeDomain,
  removeScenario,
  renameDomain,
  renameScenario,
  setSessionId,
  setSessionTitleAndGoal,
  setStackApplicability,
] as unknown;

// Guard against unused reviewer type imports for the initial test surface.
void (null as unknown as UltraPlanStackId);


describe("setStackApplicability", () => {
  test("same applicability is a no-op (identical domains)", () => {
    const d0 = baseDraft();
    const result = expectOk(setStackApplicability(d0, "frontend", "applicable"));
    const frontend = result.draft.stacks.find((s) => s.stack === "frontend")!;
    expect(frontend.applicability).toBe("applicable");
    expect(frontend.domains).toEqual([]);
  });

  test("applicable→not-applicable clears domains and zeros progress", () => {
    const d0 = baseDraft();
    const added = expectOk(addDomain(d0, "frontend", { id: "auth", name: "Auth" })).draft;
    const withScenario = expectOk(addScenario(added, { stack: "frontend", domainId: "auth", level: "unit" }, { id: "s1", title: "S1" })).draft;
    // Sanity: progress aggregates on the stack
    expect(withScenario.stacks.find((s) => s.stack === "frontend")!.progress.total).toBeGreaterThan(0);

    const result = expectOk(setStackApplicability(withScenario, "frontend", "not-applicable"));
    const frontend = result.draft.stacks.find((s) => s.stack === "frontend")!;
    expect(frontend.applicability).toBe("not-applicable");
    expect(frontend.domains).toEqual([]);
    expect(frontend.progress).toEqual({ total: 0, terminal: 0, blocked: 0 });
  });

  test("not-applicable→applicable yields domains: []", () => {
    const d0 = baseDraft();
    const nap = expectOk(setStackApplicability(d0, "frontend", "not-applicable")).draft;
    const back = expectOk(setStackApplicability(nap, "frontend", "applicable"));
    const frontend = back.draft.stacks.find((s) => s.stack === "frontend")!;
    expect(frontend.applicability).toBe("applicable");
    expect(frontend.domains).toEqual([]);
  });

  test("invalid stack id returns not-found", () => {
    const d0 = baseDraft();
    const result = expectFail(setStackApplicability(d0, "nope" as never, "applicable"));
    expect(result.reason).toEqual({ code: "not-found", where: "stack", id: "nope" });
  });
});

describe("addDomain / renameDomain / removeDomain", () => {
  test("addDomain creates domain with empty levels, review from catalog, zero progress", () => {
    const d = baseDraft();
    const result = expectOk(addDomain(d, "frontend", { id: "auth", name: "Authentication" }));
    const frontend = result.draft.stacks.find((s) => s.stack === "frontend")!;
    expect(frontend.domains).toHaveLength(1);
    const [dom] = frontend.domains;
    expect(dom).toEqual({
      id: "auth",
      name: "Authentication",
      unit: [],
      integration: [],
      e2e: [],
      review: { enabled: true, status: "pending" },
      progress: { total: 0, terminal: 0, blocked: 0 },
    });
  });

  test("addDomain with domain-review gate disabled sets review.enabled=false", () => {
    const d = buildInitialAuthoredDraft({
      sessionId: "up-test",
      title: "t",
      goal: "g",
      createdAt: CREATED_AT,
      catalog: makeCatalogFixture({
        reviewGates: { "frontend-domain-reviewer": { enabled: false } },
      }),
    });
    const result = expectOk(addDomain(d, "frontend", { id: "auth", name: "Authentication" }));
    const dom = result.draft.stacks.find((s) => s.stack === "frontend")!.domains[0];
    expect(dom.review).toEqual({ enabled: false, status: "pending" });
  });

  test("duplicate id within same stack returns duplicate-id", () => {
    const d = baseDraft();
    const d1 = expectOk(addDomain(d, "frontend", { id: "auth", name: "Authentication" })).draft;
    const result = expectFail(addDomain(d1, "frontend", { id: "auth", name: "Another" }));
    expect(result.reason).toEqual({ code: "duplicate-id", where: "domain", id: "auth" });
  });

  test("same id allowed in different stack", () => {
    const d = baseDraft();
    const d1 = expectOk(addDomain(d, "frontend", { id: "auth", name: "FE Auth" })).draft;
    const d2 = expectOk(addDomain(d1, "backend", { id: "auth", name: "BE Auth" })).draft;
    expect(d2.stacks.find((s) => s.stack === "frontend")!.domains[0].id).toBe("auth");
    expect(d2.stacks.find((s) => s.stack === "backend")!.domains[0].id).toBe("auth");
  });

  test("over-cap domain name (61 chars) is rejected", () => {
    const d = baseDraft();
    const over = "n".repeat(61);
    const result = expectFail(addDomain(d, "frontend", { id: "auth", name: over }));
    expect(result.reason).toEqual({ code: "length-cap", field: "domain.name", max: 60, got: 61 });
  });

  test("renameDomain keeps id and updates name; descendant scenarios keep domainId", () => {
    const d = baseDraft();
    const d1 = expectOk(addDomain(d, "frontend", { id: "auth", name: "Authentication" })).draft;
    const d2 = expectOk(addScenario(d1, { stack: "frontend", domainId: "auth", level: "unit" }, { id: "login", title: "Login" })).draft;
    const result = expectOk(renameDomain(d2, "frontend", "auth", { name: "User Auth" }));
    const dom = result.draft.stacks.find((s) => s.stack === "frontend")!.domains[0];
    expect(dom.id).toBe("auth");
    expect(dom.name).toBe("User Auth");
    expect(dom.unit[0].domainId).toBe("auth");
  });

  test("renameDomain with unknown id returns not-found", () => {
    const d = baseDraft();
    const result = expectFail(renameDomain(d, "frontend", "missing", { name: "X" }));
    expect(result.reason).toEqual({ code: "not-found", where: "domain", id: "missing" });
  });

  test("removeDomain drops the domain and recomputes stack progress", () => {
    const d = baseDraft();
    const d1 = expectOk(addDomain(d, "frontend", { id: "auth", name: "Authentication" })).draft;
    const d2 = expectOk(addDomain(d1, "frontend", { id: "payments", name: "Payments" })).draft;
    const result = expectOk(removeDomain(d2, "frontend", "auth"));
    const frontend = result.draft.stacks.find((s) => s.stack === "frontend")!;
    expect(frontend.domains.map((dom) => dom.id)).toEqual(["payments"]);
    expect(frontend.progress).toEqual({ total: 0, terminal: 0, blocked: 0 });
  });

  test("removeDomain with unknown id returns not-found", () => {
    const d = baseDraft();
    const result = expectFail(removeDomain(d, "frontend", "missing"));
    expect(result.reason).toEqual({ code: "not-found", where: "domain", id: "missing" });
  });
});

describe("addScenario / renameScenario / removeScenario", () => {
  const stacks = ["frontend", "backend", "infrastructure"] as const;
  const levels = ["unit", "integration", "e2e"] as const;

  function draftWithDomains() {
    let d = baseDraft();
    for (const stack of stacks) {
      d = expectOk(addDomain(d, stack, { id: "auth", name: "Auth" })).draft;
    }
    return d;
  }

  // Matrix: every (stack, level) pair places into the right bucket
  for (const stack of stacks) {
    for (const level of levels) {
      test(`addScenario: (${stack}, ${level}) seeds status/steps/proofs/slots correctly`, () => {
        const d = draftWithDomains();
        const result = expectOk(addScenario(d, { stack, domainId: "auth", level }, { id: "s1", title: "Scenario 1" }));
        const stk = result.draft.stacks.find((s) => s.stack === stack)!;
        const dom = stk.domains.find((dm) => dm.id === "auth")!;
        const bucket = dom[level];
        expect(bucket).toHaveLength(1);
        const scenario = bucket[0];
        expect(scenario.id).toBe("s1");
        expect(scenario.title).toBe("Scenario 1");
        expect(scenario.stack).toBe(stack);
        expect(scenario.domainId).toBe("auth");
        expect(scenario.level).toBe(level);
        expect(scenario.status).toBe("planned");
        expect(scenario.steps).toEqual([]);
        expect(scenario.proofs).toEqual([]);
        const expectedSlots: UltraPlanAgentSlotName[] = level === "unit"
          ? [`${stack}-executor`]
          : [`${stack}-tester`, `${stack}-executor`];
        expect(scenario.assignedSlots).toEqual(expectedSlots);
      });
    }
  }

  test("insertion order preserved within a level", () => {
    const d0 = draftWithDomains();
    const d1 = expectOk(addScenario(d0, { stack: "frontend", domainId: "auth", level: "unit" }, { id: "a", title: "A" })).draft;
    const d2 = expectOk(addScenario(d1, { stack: "frontend", domainId: "auth", level: "unit" }, { id: "b", title: "B" })).draft;
    const d3 = expectOk(addScenario(d2, { stack: "frontend", domainId: "auth", level: "unit" }, { id: "c", title: "C" })).draft;
    const unit = d3.stacks.find((s) => s.stack === "frontend")!.domains[0].unit;
    expect(unit.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  test("duplicate id within same (stack, domain, level) rejected", () => {
    const d0 = draftWithDomains();
    const d1 = expectOk(addScenario(d0, { stack: "frontend", domainId: "auth", level: "unit" }, { id: "a", title: "A" })).draft;
    const result = expectFail(addScenario(d1, { stack: "frontend", domainId: "auth", level: "unit" }, { id: "a", title: "Dup" }));
    expect(result.reason).toEqual({ code: "duplicate-id", where: "scenario", id: "a" });
  });

  test("same id allowed across different levels", () => {
    const d0 = draftWithDomains();
    const d1 = expectOk(addScenario(d0, { stack: "frontend", domainId: "auth", level: "unit" }, { id: "login", title: "A" })).draft;
    const d2 = expectOk(addScenario(d1, { stack: "frontend", domainId: "auth", level: "integration" }, { id: "login", title: "B" })).draft;
    expect(d2.stacks.find((s) => s.stack === "frontend")!.domains[0].unit[0].id).toBe("login");
    expect(d2.stacks.find((s) => s.stack === "frontend")!.domains[0].integration[0].id).toBe("login");
  });

  test("renameScenario updates title; id/stack/domainId/level unchanged", () => {
    const d0 = draftWithDomains();
    const d1 = expectOk(addScenario(d0, { stack: "frontend", domainId: "auth", level: "unit" }, { id: "login", title: "Old" })).draft;
    const result = expectOk(renameScenario(d1, { stack: "frontend", domainId: "auth", level: "unit", scenarioId: "login" }, { title: "New" }));
    const scenario = result.draft.stacks.find((s) => s.stack === "frontend")!.domains[0].unit[0];
    expect(scenario.id).toBe("login");
    expect(scenario.title).toBe("New");
    expect(scenario.stack).toBe("frontend");
    expect(scenario.domainId).toBe("auth");
    expect(scenario.level).toBe("unit");
  });

  test("removeScenario removes only the matching scenario", () => {
    const d0 = draftWithDomains();
    const d1 = expectOk(addScenario(d0, { stack: "frontend", domainId: "auth", level: "unit" }, { id: "a", title: "A" })).draft;
    const d2 = expectOk(addScenario(d1, { stack: "frontend", domainId: "auth", level: "unit" }, { id: "b", title: "B" })).draft;
    const d3 = expectOk(addScenario(d2, { stack: "frontend", domainId: "auth", level: "integration" }, { id: "a", title: "A-int" })).draft;
    const result = expectOk(removeScenario(d3, { stack: "frontend", domainId: "auth", level: "unit", scenarioId: "a" }));
    const dom = result.draft.stacks.find((s) => s.stack === "frontend")!.domains[0];
    expect(dom.unit.map((s) => s.id)).toEqual(["b"]);
    expect(dom.integration.map((s) => s.id)).toEqual(["a"]);
  });

  test("over-cap scenario title (121 chars) rejected", () => {
    const d0 = draftWithDomains();
    const over = "t".repeat(121);
    const result = expectFail(addScenario(d0, { stack: "frontend", domainId: "auth", level: "unit" }, { id: "a", title: over }));
    expect(result.reason).toEqual({ code: "length-cap", field: "scenario.title", max: 120, got: 121 });
  });

  test("renameScenario on unknown id returns not-found", () => {
    const d = draftWithDomains();
    const result = expectFail(renameScenario(d, { stack: "frontend", domainId: "auth", level: "unit", scenarioId: "missing" }, { title: "X" }));
    expect(result.reason).toEqual({ code: "not-found", where: "scenario", id: "missing" });
  });

  test("addScenario on unknown domain returns not-found", () => {
    const d = baseDraft(); // no domains added
    const result = expectFail(addScenario(d, { stack: "frontend", domainId: "missing", level: "unit" }, { id: "a", title: "A" }));
    expect(result.reason).toEqual({ code: "not-found", where: "domain", id: "missing" });
  });
});

import {
  isUltraPlanIndexEntry,
  isUltraPlanManifest,
} from "../../src/ultraplan/contracts.js";

function richDraft() {
  let d = baseDraft();
  d = expectOk(addDomain(d, "frontend", { id: "auth", name: "Auth" })).draft;
  d = expectOk(addScenario(d, { stack: "frontend", domainId: "auth", level: "unit" }, { id: "login", title: "Login renders" })).draft;
  d = expectOk(addScenario(d, { stack: "frontend", domainId: "auth", level: "integration" }, { id: "flow", title: "Login flow" })).draft;
  d = expectOk(setStackApplicability(d, "infrastructure", "not-applicable")).draft;
  return d;
}

const NOW = new Date("2026-04-22T10:00:00.000Z");

describe("draftToAuthoredArtifact / draftToManifest / draftToIndexEntry", () => {
  test("draftToAuthoredArtifact sets updatedAt to now; rest byte-identical", () => {
    const d = richDraft();
    const artifact = draftToAuthoredArtifact(d, NOW);
    expect(artifact.updatedAt).toBe(NOW.toISOString());
    // All other fields must be identical to the draft
    const { updatedAt: _discard, ...rest } = artifact;
    const { updatedAt: _discard2, ...draftRest } = d;
    expect(rest).toEqual(draftRest);
    expect(isUltraPlanAuthoredArtifact(artifact)).toBe(true);
  });

  test("draftToManifest produces canonical manifest with cursor, stacks, reviews", () => {
    const d = richDraft();
    const manifest = draftToManifest(d, "proj", NOW);
    expect(manifest.projectName).toBe("proj");
    expect(manifest.authored).toEqual({ json: "authored.json" });
    expect(manifest.state).toBe("ready");
    expect(manifest.lastCompleted).toBeNull();
    expect(manifest.blocker).toBeNull();
    expect(manifest.updatedAt).toBe(NOW.toISOString());
    expect(manifest.createdAt).toBe(d.createdAt);
    expect(manifest.cursor).toEqual(initialCursor(d));
    expect(manifest.stacks).toHaveLength(3);
    expect(manifest.stacks.map((s) => s.stack)).toEqual(["frontend", "backend", "infrastructure"]);
    // Frontend applicable with 1 domain + 2 scenarios
    const fe = manifest.stacks.find((s) => s.stack === "frontend")!;
    expect(fe.applicability).toBe("applicable");
    expect(fe.domainCount).toBe(1);
    expect(fe.progress).toEqual({ total: 2, terminal: 0, blocked: 0 });
    // Infra not-applicable
    const infra = manifest.stacks.find((s) => s.stack === "infrastructure")!;
    expect(infra.applicability).toBe("not-applicable");
    // Reviews: one stack review per applicable stack with gate enabled, one domain review per domain
    const reviewTypes = manifest.reviews.map((r) => `${r.type}:${r.stack}:${r.domainId ?? ""}`);
    expect(reviewTypes).toContain("stack:frontend:");
    expect(reviewTypes).toContain("stack:backend:");
    expect(reviewTypes).toContain("domain:frontend:auth");
    // Infra is not-applicable → no reviews for it
    expect(reviewTypes.some((t) => t.startsWith("stack:infrastructure"))).toBe(false);
    // All review statuses pending
    for (const r of manifest.reviews) {
      expect(r.status).toBe("pending");
    }
    expect(isUltraPlanManifest(manifest)).toBe(true);
  });

  test("draftToManifest omits reviews for stacks with gates disabled", () => {
    let d = buildInitialAuthoredDraft({
      sessionId: "up",
      title: "t",
      goal: "g",
      createdAt: CREATED_AT,
      catalog: makeCatalogFixture({
        reviewGates: {
          "frontend-domain-reviewer": { enabled: false },
          "frontend-stack-reviewer": { enabled: false },
        },
      }),
    });
    d = expectOk(addDomain(d, "frontend", { id: "a", name: "A" })).draft;
    d = expectOk(addScenario(d, { stack: "frontend", domainId: "a", level: "unit" }, { id: "s", title: "S" })).draft;
    const manifest = draftToManifest(d, "p", NOW);
    const feReviews = manifest.reviews.filter((r) => r.stack === "frontend");
    expect(feReviews).toEqual([]);
  });

  test("draftToManifest progress aggregates across stacks", () => {
    const d = richDraft();
    const manifest = draftToManifest(d, "p", NOW);
    // frontend has 2 scenarios, others 0; infra not-applicable
    expect(manifest.progress).toEqual({ total: 2, terminal: 0, blocked: 0 });
  });

  test("draftToIndexEntry yields state=ready, bucket=pending, idleReason=null, cursor, timestamps", () => {
    const d = richDraft();
    const entry = draftToIndexEntry(d, NOW);
    expect(entry.sessionId).toBe(d.sessionId);
    expect(entry.title).toBe(d.title);
    expect(entry.state).toBe("ready");
    expect(entry.bucket).toBe("pending");
    expect(entry.idleReason).toBeNull();
    expect(entry.cursor).toEqual(initialCursor(d));
    expect(entry.createdAt).toBe(d.createdAt);
    expect(entry.updatedAt).toBe(NOW.toISOString());
    expect(isUltraPlanIndexEntry(entry)).toBe(true);
  });
});

describe("initialCursor", () => {
  test("frontend applicable + 1 unit scenario → cursor targets that scenario (red/planned)", () => {
    let d = baseDraft();
    d = expectOk(addDomain(d, "frontend", { id: "auth", name: "Auth" })).draft;
    d = expectOk(addScenario(d, { stack: "frontend", domainId: "auth", level: "unit" }, { id: "login", title: "Login works" })).draft;
    const cursor = initialCursor(d);
    expect(cursor.targetType).toBe("scenario");
    expect(cursor.stack).toBe("frontend");
    expect(cursor.domainId).toBe("auth");
    expect(cursor.level).toBe("unit");
    expect(cursor.scenarioId).toBe("login");
    expect(cursor.phase).toBe("red");
    expect(cursor.status).toBe("planned");
    expect(cursor.summary).toBe("Login works");
  });

  test("frontend not-applicable, backend applicable → cursor is in backend", () => {
    let d = baseDraft();
    d = expectOk(setStackApplicability(d, "frontend", "not-applicable")).draft;
    d = expectOk(addDomain(d, "backend", { id: "api", name: "API" })).draft;
    d = expectOk(addScenario(d, { stack: "backend", domainId: "api", level: "unit" }, { id: "health", title: "Health endpoint" })).draft;
    const cursor = initialCursor(d);
    expect(cursor.stack).toBe("backend");
    expect(cursor.domainId).toBe("api");
    expect(cursor.scenarioId).toBe("health");
  });

  test("unit=[]; integration=[s] picks integration", () => {
    let d = baseDraft();
    d = expectOk(addDomain(d, "frontend", { id: "auth", name: "Auth" })).draft;
    d = expectOk(addScenario(d, { stack: "frontend", domainId: "auth", level: "integration" }, { id: "flow", title: "Login flow" })).draft;
    const cursor = initialCursor(d);
    expect(cursor.level).toBe("integration");
    expect(cursor.scenarioId).toBe("flow");
  });
});

describe("isDraftReadyToPersist", () => {
  test("all-not-applicable → empty-session", () => {
    let d = baseDraft();
    d = expectOk(setStackApplicability(d, "frontend", "not-applicable")).draft;
    d = expectOk(setStackApplicability(d, "backend", "not-applicable")).draft;
    d = expectOk(setStackApplicability(d, "infrastructure", "not-applicable")).draft;
    const r = isDraftReadyToPersist(d);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.blockers).toContainEqual({ code: "empty-session" });
    }
  });

  test("applicable stack with zero domains → empty-applicable-stack", () => {
    let d = baseDraft();
    d = expectOk(setStackApplicability(d, "backend", "not-applicable")).draft;
    d = expectOk(setStackApplicability(d, "infrastructure", "not-applicable")).draft;
    const r = isDraftReadyToPersist(d);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.blockers).toContainEqual({ code: "empty-applicable-stack", stack: "frontend" });
    }
  });

  test("applicable domain with zero scenarios → empty-domain", () => {
    let d = baseDraft();
    d = expectOk(setStackApplicability(d, "backend", "not-applicable")).draft;
    d = expectOk(setStackApplicability(d, "infrastructure", "not-applicable")).draft;
    d = expectOk(addDomain(d, "frontend", { id: "auth", name: "Auth" })).draft;
    const r = isDraftReadyToPersist(d);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.blockers).toContainEqual({ code: "empty-domain", stack: "frontend", domainId: "auth" });
    }
  });

  test("fully-populated draft → ok: true", () => {
    let d = baseDraft();
    d = expectOk(setStackApplicability(d, "backend", "not-applicable")).draft;
    d = expectOk(setStackApplicability(d, "infrastructure", "not-applicable")).draft;
    d = expectOk(addDomain(d, "frontend", { id: "auth", name: "Auth" })).draft;
    d = expectOk(addScenario(d, { stack: "frontend", domainId: "auth", level: "unit" }, { id: "login", title: "Login" })).draft;
    const r = isDraftReadyToPersist(d);
    expect(r).toEqual({ ok: true });
  });

  test("draft with agentSlots.executor === null (bypassed) → missing-required-slot", () => {
    let d = baseDraft();
    d = expectOk(setStackApplicability(d, "backend", "not-applicable")).draft;
    d = expectOk(setStackApplicability(d, "infrastructure", "not-applicable")).draft;
    d = expectOk(addDomain(d, "frontend", { id: "auth", name: "Auth" })).draft;
    d = expectOk(addScenario(d, { stack: "frontend", domainId: "auth", level: "unit" }, { id: "login", title: "Login" })).draft;
    // Bypass TypeBox to simulate a bug
    const broken = { ...d, stacks: d.stacks.map((s, i) => i === 0 ? { ...s, agentSlots: { ...s.agentSlots, executor: null as unknown } } : s) } as unknown as typeof d;
    const r = isDraftReadyToPersist(broken);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.blockers.some((b) => b.code === "missing-required-slot")).toBe(true);
    }
  });
});