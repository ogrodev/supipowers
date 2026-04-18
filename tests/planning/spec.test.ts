import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import {
  PlanSpecSchema,
  PlanSpecTaskSchema,
  TASK_COMPLEXITY_VALUES,
} from "../../src/planning/spec.js";

describe("PlanSpecTaskSchema", () => {
  test("accepts a minimal valid task", () => {
    const task = {
      id: 1,
      name: "Do the thing",
      description: "Do the thing",
      files: ["src/x.ts"],
      criteria: "covered by tests",
      complexity: "small",
    };
    expect(Value.Check(PlanSpecTaskSchema, task)).toBe(true);
  });

  test("accepts an optional model", () => {
    const task = {
      id: 2,
      name: "N",
      description: "",
      files: [],
      criteria: "",
      complexity: "medium",
      model: "claude-opus-4-5",
    };
    expect(Value.Check(PlanSpecTaskSchema, task)).toBe(true);
  });

  test("rejects unknown complexity", () => {
    const task = {
      id: 1,
      name: "N",
      description: "",
      files: [],
      criteria: "",
      complexity: "epic",
    };
    expect(Value.Check(PlanSpecTaskSchema, task)).toBe(false);
  });

  test("rejects zero or negative id", () => {
    const task = {
      id: 0,
      name: "N",
      description: "",
      files: [],
      criteria: "",
      complexity: "small",
    };
    expect(Value.Check(PlanSpecTaskSchema, task)).toBe(false);
  });

  test("rejects extra properties", () => {
    const task = {
      id: 1,
      name: "N",
      description: "",
      files: [],
      criteria: "",
      complexity: "small",
      bogus: true,
    };
    expect(Value.Check(PlanSpecTaskSchema, task)).toBe(false);
  });
});

describe("PlanSpecSchema", () => {
  const minimal = {
    name: "feature-x",
    created: "2026-04-17",
    tags: [],
    context: "Add feature X.",
    tasks: [
      {
        id: 1,
        name: "Do the thing",
        description: "Do the thing",
        files: ["src/x.ts"],
        criteria: "covered by tests",
        complexity: "small",
      },
    ],
  };

  test("accepts a minimal valid plan", () => {
    expect(Value.Check(PlanSpecSchema, minimal)).toBe(true);
  });

  test("accepts an empty task list (agent may plan without tasks initially)", () => {
    expect(Value.Check(PlanSpecSchema, { ...minimal, tasks: [] })).toBe(true);
  });

  test("tolerates empty created string (legacy plans)", () => {
    expect(Value.Check(PlanSpecSchema, { ...minimal, created: "" })).toBe(true);
  });

  test("rejects missing name", () => {
    const plan: any = { ...minimal };
    delete plan.name;
    expect(Value.Check(PlanSpecSchema, plan)).toBe(false);
  });

  test("rejects extra top-level properties", () => {
    expect(Value.Check(PlanSpecSchema, { ...minimal, filePath: "x.md" })).toBe(false);
  });
});

describe("TASK_COMPLEXITY_VALUES", () => {
  test("exposes the canonical complexity levels", () => {
    expect(TASK_COMPLEXITY_VALUES).toEqual(["small", "medium", "large"]);
  });
});
