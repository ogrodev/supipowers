import { describe, expect, test } from "bun:test";
import { isPlanSpec, validatePlanSpec } from "../../src/planning/validate.js";

const VALID = {
  name: "feature-x",
  created: "2026-04-17",
  tags: ["refactor"],
  context: "Context.",
  tasks: [
    {
      id: 1,
      name: "One",
      description: "One",
      files: ["src/x.ts"],
      criteria: "c",
      complexity: "small",
    },
  ],
};

describe("validatePlanSpec", () => {
  test("returns output on valid input", () => {
    const result = validatePlanSpec(VALID);
    expect(result.error).toBeNull();
    expect(result.errors.length).toBe(0);
    expect(result.output?.name).toBe("feature-x");
  });

  test("returns field-level errors on invalid input", () => {
    const bad = { ...VALID, tasks: [{ ...VALID.tasks[0], complexity: "epic" }] };
    const result = validatePlanSpec(bad);
    expect(result.output).toBeNull();
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.error).toContain("complexity");
  });

  test("returns a generic error when top-level shape is wrong", () => {
    const result = validatePlanSpec("not-a-plan");
    expect(result.output).toBeNull();
    expect(result.error).not.toBeNull();
  });

  test("returns null output when fields are missing", () => {
    const result = validatePlanSpec({ name: "x" });
    expect(result.output).toBeNull();
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe("isPlanSpec", () => {
  test("true for a valid plan", () => {
    expect(isPlanSpec(VALID)).toBe(true);
  });

  test("false for an invalid plan", () => {
    expect(isPlanSpec({})).toBe(false);
    expect(isPlanSpec(null)).toBe(false);
    expect(isPlanSpec("x")).toBe(false);
  });
});
