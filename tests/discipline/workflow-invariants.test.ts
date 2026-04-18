import { describe, expect, test } from "bun:test";
import {
  checkInvariants,
  formatInvariantResult,
  requireArtifact,
  requireCondition,
  requireNoPendingWork,
  type WorkflowInvariant,
} from "../../src/discipline/workflow-invariants.js";

describe("checkInvariants", () => {
  test("returns satisfied when every invariant is satisfied", async () => {
    const invariants: WorkflowInvariant<{}>[] = [
      requireCondition("always-true", () => true, "never fires"),
      requireCondition("other", () => true, "never fires"),
    ];
    const result = await checkInvariants(invariants, {});
    expect(result.state).toBe("satisfied");
  });

  test("returns the first blocker when any invariant fails", async () => {
    const invariants: WorkflowInvariant<{}>[] = [
      requireCondition("first-ok", () => true, "never fires"),
      requireCondition("second-blocks", () => false, "second reason"),
      requireCondition("never-checked", () => false, "should not appear"),
    ];
    const result = await checkInvariants(invariants, {});
    expect(result.state).toBe("blocked");
    if (result.state === "blocked") {
      expect(result.invariant).toBe("second-blocks");
      expect(result.reason).toBe("second reason");
    }
  });

  test("supports async predicates", async () => {
    const invariants: WorkflowInvariant<{}>[] = [
      requireCondition(
        "async-blocks",
        async () => {
          await Promise.resolve();
          return false;
        },
        "async failure",
      ),
    ];
    const result = await checkInvariants(invariants, {});
    expect(result.state).toBe("blocked");
  });

  test("passes context through to the predicate", async () => {
    const invariants: WorkflowInvariant<{ n: number }>[] = [
      requireCondition("positive", (ctx) => ctx.n > 0, "n must be positive"),
    ];

    expect((await checkInvariants(invariants, { n: 5 })).state).toBe("satisfied");
    const blocked = await checkInvariants(invariants, { n: -1 });
    expect(blocked.state).toBe("blocked");
    if (blocked.state === "blocked") {
      expect(blocked.reason).toBe("n must be positive");
    }
  });
});

describe("requireArtifact", () => {
  test("satisfied when the artifact predicate returns true", async () => {
    const inv = requireArtifact("plan-file", () => true, ".omp/supipowers/plans/x.md");
    const result = await inv.check({});
    expect(result.state).toBe("satisfied");
  });

  test("blocks with an artifact-label reason when the predicate returns false", async () => {
    const inv = requireArtifact("plan-file", () => false, ".omp/supipowers/plans/x.md");
    const result = await inv.check({});
    expect(result.state).toBe("blocked");
    if (result.state === "blocked") {
      expect(result.reason).toContain(".omp/supipowers/plans/x.md");
      expect(result.reason).toContain("Required artifact is missing");
    }
  });
});

describe("requireNoPendingWork", () => {
  test("satisfied when pending count is zero", async () => {
    const inv = requireNoPendingWork("todos", () => 0, "todo items");
    expect((await inv.check({})).state).toBe("satisfied");
  });

  test("blocks with count and label when pending", async () => {
    const inv = requireNoPendingWork("todos", () => 3, "todo items");
    const result = await inv.check({});
    expect(result.state).toBe("blocked");
    if (result.state === "blocked") {
      expect(result.reason).toContain("3");
      expect(result.reason).toContain("todo items");
    }
  });
});

describe("formatInvariantResult", () => {
  test("satisfied renders as empty string", () => {
    expect(formatInvariantResult({ state: "satisfied" })).toBe("");
  });

  test("blocked renders invariant name and reason", () => {
    const rendered = formatInvariantResult({
      state: "blocked",
      invariant: "plan-file",
      reason: "missing plan.md",
    });
    expect(rendered).toBe("[plan-file] missing plan.md");
  });
});
