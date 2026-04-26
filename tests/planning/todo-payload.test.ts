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

  test("3-task plan produces a single replace op with one phase named 'I. Implementation'", () => {
    const result = buildTodoWriteOpsForPlan(
      plan([
        task({ id: 1, name: "Add types" }),
        task({ id: 2, name: "Add loader" }),
        task({ id: 3, name: "Wire runner" }),
      ]),
    );

    expect(result.ops).toHaveLength(1);
    const [first] = result.ops;
    expect(first.op).toBe("replace");
    if (first.op !== "replace") throw new Error("type narrowing failed");
    expect(first.phases).toHaveLength(1);
    expect(first.phases[0].name).toBe("I. Implementation");
    expect(first.phases[0].tasks).toEqual([
      { content: "Add types" },
      { content: "Add loader" },
      { content: "Wire runner" },
    ]);
  });

  test("tasks with non-empty criteria produce follow-up note ops", () => {
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
      { op: "note", task: "task-1", text: "Tests pass" },
      { op: "note", task: "task-4", text: "Lint clean" },
    ]);
  });

  test("long task names are truncated to 200 chars with ellipsis", () => {
    const longName = "x".repeat(500);
    const result = buildTodoWriteOpsForPlan(
      plan([task({ id: 1, name: longName })]),
    );

    const [first] = result.ops;
    if (first.op !== "replace") throw new Error("type narrowing failed");
    const content = first.phases[0].tasks[0].content;
    expect(content.length).toBe(200);
    expect(content.endsWith("\u2026")).toBe(true);
  });

  test("task names exactly at the cap are passed through unchanged", () => {
    const cappedName = "y".repeat(200);
    const result = buildTodoWriteOpsForPlan(
      plan([task({ id: 1, name: cappedName })]),
    );

    const [first] = result.ops;
    if (first.op !== "replace") throw new Error("type narrowing failed");
    expect(first.phases[0].tasks[0].content).toBe(cappedName);
  });
});
