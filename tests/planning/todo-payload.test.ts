import { describe, expect, test } from "bun:test";
import { buildTodoWriteOpsForPlan } from "../../src/planning/approval-flow.js";
import type { Plan, PlanTask } from "../../src/types.js";

function task(overrides: Partial<PlanTask> & { id: number; name: string }): PlanTask {
  return {
    description: overrides.name,
    files: [],
    criteria: "",
    complexity: "small",
    ...overrides,
  };
}

function plan(tasks: PlanTask[]): Plan {
  return {
    name: "test-plan",
    created: "2026-04-26",
    tags: [],
    context: "",
    tasks,
    filePath: "test-plan.md",
  };
}

describe("buildTodoWriteOpsForPlan", () => {
  test("empty plan returns no ops", () => {
    const result = buildTodoWriteOpsForPlan(plan([]));
    expect(result).toEqual({ ops: [] });
  });

  test("3-task plan produces a single init op with one phase named 'Implementation'", () => {
    const result = buildTodoWriteOpsForPlan(
      plan([
        task({ id: 1, name: "Add types" }),
        task({ id: 2, name: "Add loader" }),
        task({ id: 3, name: "Wire runner" }),
      ]),
    );

    expect(result.ops).toHaveLength(1);
    const [first] = result.ops;
    expect(first.op).toBe("init");
    if (first.op !== "init") throw new Error("type narrowing failed");
    expect(first.list).toHaveLength(1);
    expect(first.list[0].phase).toBe("Implementation");
    expect(first.list[0].items).toEqual(["Add types", "Add loader", "Wire runner"]);
  });

  test("tasks with non-empty criteria produce follow-up note ops keyed by task content", () => {
    const result = buildTodoWriteOpsForPlan(
      plan([
        task({ id: 10, name: "First", criteria: "Tests pass" }),
        task({ id: 20, name: "Second", criteria: "" }),
        task({ id: 30, name: "Third", criteria: "  " }),
        task({ id: 40, name: "Fourth", criteria: "Lint clean" }),
      ]),
    );

    const noteOps = result.ops.filter((op) => op.op === "note");
    expect(noteOps).toEqual([
      { op: "note", task: "First", text: "Tests pass" },
      { op: "note", task: "Fourth", text: "Lint clean" },
    ]);
  });

  test("duplicate task names are de-duplicated and notes target distinct labels", () => {
    const result = buildTodoWriteOpsForPlan(
      plan([
        task({ id: 1, name: "Deploy", criteria: "First criteria" }),
        task({ id: 2, name: "Deploy", criteria: "Second criteria" }),
        task({ id: 3, name: "Deploy (2)", criteria: "Existing suffix" }),
      ]),
    );

    const [first, ...noteOps] = result.ops;
    if (first.op !== "init") throw new Error("type narrowing failed");
    expect(first.list[0].items).toEqual(["Deploy", "Deploy (2)", "Deploy (2) (2)"]);
    expect(noteOps).toEqual([
      { op: "note", task: "Deploy", text: "First criteria" },
      { op: "note", task: "Deploy (2)", text: "Second criteria" },
      { op: "note", task: "Deploy (2) (2)", text: "Existing suffix" },
    ]);
  });

  test("long task names are truncated to 200 chars with ellipsis and notes target the truncated label", () => {
    const longName = "x".repeat(500);
    const result = buildTodoWriteOpsForPlan(
      plan([task({ id: 1, name: longName, criteria: "Tests pass" })]),
    );

    const [first, note] = result.ops;
    if (first.op !== "init") throw new Error("type narrowing failed");
    const item = first.list[0].items[0];
    expect(item.length).toBe(200);
    expect(item.endsWith("\u2026")).toBe(true);

    if (note.op !== "note") throw new Error("note op missing");
    expect(note.task).toBe(item);
    expect(note.text).toBe("Tests pass");
  });

  test("long duplicate task names remain unique within the label cap", () => {
    const longName = "x".repeat(500);
    const result = buildTodoWriteOpsForPlan(
      plan([
        task({ id: 1, name: longName }),
        task({ id: 2, name: longName }),
      ]),
    );

    const [first] = result.ops;
    if (first.op !== "init") throw new Error("type narrowing failed");
    const items = first.list[0].items;
    expect(new Set(items).size).toBe(2);
    expect(items.every((item) => item.length <= 200)).toBe(true);
    expect(items[1].endsWith("(2)")).toBe(true);
  });

  test("task names exactly at the cap are passed through unchanged", () => {
    const cappedName = "y".repeat(200);
    const result = buildTodoWriteOpsForPlan(
      plan([task({ id: 1, name: cappedName })]),
    );

    const [first] = result.ops;
    if (first.op !== "init") throw new Error("type narrowing failed");
    expect(first.list[0].items[0]).toBe(cappedName);
  });
});
