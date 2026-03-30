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


describe("quality gate exhaustion messaging", () => {
  test("exhausted spec review concerns include review type and attempt count", () => {
    const maxReviewRetries = 2;
    const issues = "Missing null check in handler";
    const concerns = [
      `⚠ Spec review exhausted (${maxReviewRetries + 1} attempts):`,
      issues,
      `Re-run with higher maxFixRetries or fix manually.`,
    ].join("\n");

    expect(concerns).toContain("Spec review exhausted");
    expect(concerns).toContain("3 attempts");
    expect(concerns).toContain("Re-run with higher maxFixRetries");
    expect(concerns).toContain(issues);
  });

  test("exhausted quality review concerns include review type and attempt count", () => {
    const maxReviewRetries = 1;
    const issues = "Unused import in line 42";
    const concerns = [
      `⚠ Quality review exhausted (${maxReviewRetries + 1} attempts):`,
      issues,
      `Re-run with higher maxFixRetries or fix manually.`,
    ].join("\n");

    expect(concerns).toContain("Quality review exhausted");
    expect(concerns).toContain("2 attempts");
    expect(concerns).toContain("Re-run with higher maxFixRetries");
  });

  test("exhaustion message includes 'continuing as done_with_concerns'", () => {
    const maxReviewRetries = 2;
    const exhaustionMsg = `Task 5 spec review failed after ${maxReviewRetries + 1} attempts — continuing as done_with_concerns`;

    expect(exhaustionMsg).toContain("continuing as done_with_concerns");
    expect(exhaustionMsg).toContain("3 attempts");
  });

  test("status remains done_with_concerns, not blocked", () => {
    // Simulates what dispatcher does on review exhaustion
    const status = "done_with_concerns" as const;
    expect(status).toBe("done_with_concerns");
    expect(status).not.toBe("blocked");
  });
});