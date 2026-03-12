import { describe, test, expect } from "vitest";
import { buildPlanReviewerPrompt } from "../../src/planning/plan-reviewer.js";

describe("plan reviewer prompt", () => {
  test("includes the plan file path", () => {
    const prompt = buildPlanReviewerPrompt("/path/to/plan.md", "/path/to/spec.md", 1);
    expect(prompt).toContain("/path/to/plan.md");
  });

  test("includes the spec file path for reference", () => {
    const prompt = buildPlanReviewerPrompt("/path/to/plan.md", "/path/to/spec.md", 1);
    expect(prompt).toContain("/path/to/spec.md");
  });

  test("includes chunk number", () => {
    const prompt = buildPlanReviewerPrompt("/path/to/plan.md", "/path/to/spec.md", 3);
    expect(prompt).toContain("Chunk 3");
  });

  test("includes spec alignment check", () => {
    const prompt = buildPlanReviewerPrompt("/path/to/plan.md", "/path/to/spec.md", 1);
    expect(prompt).toContain("Spec Alignment");
  });

  test("includes task decomposition check", () => {
    const prompt = buildPlanReviewerPrompt("/path/to/plan.md", "/path/to/spec.md", 1);
    expect(prompt).toContain("Task Decomposition");
  });

  test("includes checkbox syntax check", () => {
    const prompt = buildPlanReviewerPrompt("/path/to/plan.md", "/path/to/spec.md", 1);
    expect(prompt).toContain("Checkbox");
  });

  test("includes output format with Approved/Issues Found", () => {
    const prompt = buildPlanReviewerPrompt("/path/to/plan.md", "/path/to/spec.md", 1);
    expect(prompt).toContain("Approved");
    expect(prompt).toContain("Issues Found");
  });
});
