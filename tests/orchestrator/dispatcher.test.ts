import { describe, test, expect } from "vitest";
import type { ReviewResult } from "../../src/orchestrator/dispatcher.js";

describe("dispatcher types", () => {
  test("ReviewResult interface has passed and issues fields", () => {
    const result: ReviewResult = { passed: true, issues: "" };
    expect(result.passed).toBe(true);
    expect(result.issues).toBe("");
  });

  test("ReviewResult can represent failure with issues", () => {
    const result: ReviewResult = {
      passed: false,
      issues: "Missing error handling for empty input",
    };
    expect(result.passed).toBe(false);
    expect(result.issues).toContain("Missing error handling");
  });
});
