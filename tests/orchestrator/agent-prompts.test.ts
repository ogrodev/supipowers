import { describe, test, expect } from "vitest";
import {
  buildImplementerPrompt,
  buildSpecComplianceReviewPrompt,
  buildCodeQualityReviewPrompt,
} from "../../src/orchestrator/agent-prompts.js";
import type { PlanTask } from "../../src/types.js";

const sampleTask: PlanTask = {
  id: 1,
  name: "Add user validation",
  description: "Implement email validation for the user registration form",
  files: ["src/validators/email.ts", "tests/validators/email.test.ts"],
  criteria: "Email validation rejects invalid formats and accepts valid ones",
  complexity: "small",
  parallelism: { type: "parallel-safe" },
};

describe("implementer prompt", () => {
  test("includes task name and description", () => {
    const prompt = buildImplementerPrompt({
      task: sampleTask,
      planContext: "Building a registration system",
      workDir: "/path/to/worktree",
    });
    expect(prompt).toContain("Add user validation");
    expect(prompt).toContain("email validation");
  });

  test("includes plan context", () => {
    const prompt = buildImplementerPrompt({
      task: sampleTask,
      planContext: "Building a registration system",
      workDir: "/path/to/worktree",
    });
    expect(prompt).toContain("Building a registration system");
  });

  test("includes work directory", () => {
    const prompt = buildImplementerPrompt({
      task: sampleTask,
      planContext: "",
      workDir: "/path/to/worktree",
    });
    expect(prompt).toContain("/path/to/worktree");
  });

  test("includes ask-before-starting section", () => {
    const prompt = buildImplementerPrompt({
      task: sampleTask,
      planContext: "",
      workDir: "/tmp",
    });
    expect(prompt).toContain("Before You Begin");
    expect(prompt).toContain("Ask them now");
  });

  test("includes TDD instructions", () => {
    const prompt = buildImplementerPrompt({
      task: sampleTask,
      planContext: "",
      workDir: "/tmp",
    });
    expect(prompt).toContain("TDD");
    expect(prompt).toContain("test");
  });

  test("includes self-review section", () => {
    const prompt = buildImplementerPrompt({
      task: sampleTask,
      planContext: "",
      workDir: "/tmp",
    });
    expect(prompt).toContain("Self-Review");
    expect(prompt).toContain("Completeness");
    expect(prompt).toContain("Quality");
    expect(prompt).toContain("YAGNI");
  });

  test("includes escalation guidance", () => {
    const prompt = buildImplementerPrompt({
      task: sampleTask,
      planContext: "",
      workDir: "/tmp",
    });
    expect(prompt).toContain("BLOCKED");
    expect(prompt).toContain("NEEDS_CONTEXT");
    expect(prompt).toContain("escalat");
  });

  test("includes report format with all status types", () => {
    const prompt = buildImplementerPrompt({
      task: sampleTask,
      planContext: "",
      workDir: "/tmp",
    });
    expect(prompt).toContain("DONE");
    expect(prompt).toContain("DONE_WITH_CONCERNS");
    expect(prompt).toContain("BLOCKED");
    expect(prompt).toContain("NEEDS_CONTEXT");
  });

  test("includes target files", () => {
    const prompt = buildImplementerPrompt({
      task: sampleTask,
      planContext: "",
      workDir: "/tmp",
    });
    expect(prompt).toContain("src/validators/email.ts");
    expect(prompt).toContain("tests/validators/email.test.ts");
  });

  test("includes acceptance criteria", () => {
    const prompt = buildImplementerPrompt({
      task: sampleTask,
      planContext: "",
      workDir: "/tmp",
    });
    expect(prompt).toContain("rejects invalid formats");
  });
});

describe("spec compliance review prompt", () => {
  test("includes task requirements", () => {
    const prompt = buildSpecComplianceReviewPrompt({
      taskRequirements: "Implement email validation that rejects invalid formats",
      implementerReport: "I implemented the validation function",
    });
    expect(prompt).toContain("email validation");
  });

  test("includes implementer report", () => {
    const prompt = buildSpecComplianceReviewPrompt({
      taskRequirements: "Some requirements",
      implementerReport: "I implemented the validation function with regex",
    });
    expect(prompt).toContain("validation function with regex");
  });

  test("includes do-not-trust warning", () => {
    const prompt = buildSpecComplianceReviewPrompt({
      taskRequirements: "req",
      implementerReport: "report",
    });
    expect(prompt).toContain("Do Not Trust");
  });

  test("checks for missing requirements", () => {
    const prompt = buildSpecComplianceReviewPrompt({
      taskRequirements: "req",
      implementerReport: "report",
    });
    expect(prompt).toContain("Missing");
    expect(prompt).toContain("skipped");
  });

  test("checks for extra/unneeded work", () => {
    const prompt = buildSpecComplianceReviewPrompt({
      taskRequirements: "req",
      implementerReport: "report",
    });
    expect(prompt).toContain("Extra");
    expect(prompt).toContain("over-engineer");
  });

  test("checks for misunderstandings", () => {
    const prompt = buildSpecComplianceReviewPrompt({
      taskRequirements: "req",
      implementerReport: "report",
    });
    expect(prompt).toContain("Misunderstanding");
  });

  test("includes verify-by-reading-code instruction", () => {
    const prompt = buildSpecComplianceReviewPrompt({
      taskRequirements: "req",
      implementerReport: "report",
    });
    expect(prompt).toContain("reading code");
  });

  test("includes output format", () => {
    const prompt = buildSpecComplianceReviewPrompt({
      taskRequirements: "req",
      implementerReport: "report",
    });
    expect(prompt).toContain("Spec compliant");
    expect(prompt).toContain("Issues found");
  });
});

describe("code quality review prompt", () => {
  test("includes what was implemented", () => {
    const prompt = buildCodeQualityReviewPrompt({
      taskSummary: "Added email validation to registration",
      implementerReport: "Built the validator with comprehensive tests",
      baseSha: "abc123",
      headSha: "def456",
    });
    expect(prompt).toContain("email validation");
  });

  test("includes git SHAs for diff", () => {
    const prompt = buildCodeQualityReviewPrompt({
      taskSummary: "task",
      implementerReport: "report",
      baseSha: "abc123",
      headSha: "def456",
    });
    expect(prompt).toContain("abc123");
    expect(prompt).toContain("def456");
  });

  test("checks for file responsibility", () => {
    const prompt = buildCodeQualityReviewPrompt({
      taskSummary: "task",
      implementerReport: "report",
      baseSha: "a",
      headSha: "b",
    });
    expect(prompt).toContain("one clear responsibility");
  });

  test("checks code quality concerns", () => {
    const prompt = buildCodeQualityReviewPrompt({
      taskSummary: "task",
      implementerReport: "report",
      baseSha: "a",
      headSha: "b",
    });
    expect(prompt).toContain("Critical");
    expect(prompt).toContain("Important");
    expect(prompt).toContain("Minor");
  });

  test("includes implementer report", () => {
    const prompt = buildCodeQualityReviewPrompt({
      taskSummary: "task",
      implementerReport: "Built validator with edge case handling",
      baseSha: "a",
      headSha: "b",
    });
    expect(prompt).toContain("edge case handling");
  });
});
