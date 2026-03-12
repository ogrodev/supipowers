import { describe, test, expect } from "vitest";
import { buildFixPrOrchestratorPrompt } from "../../src/fix-pr/prompt-builder.js";
import { DEFAULT_FIX_PR_CONFIG } from "../../src/fix-pr/config.js";

const SAMPLE_COMMENTS = '{"id":1,"path":"src/foo.ts","line":10,"body":"This needs fixing","user":"reviewer"}\n{"id":2,"path":"src/bar.ts","line":20,"body":"Add error handling","user":"reviewer"}';

function buildDefaultPrompt() {
  return buildFixPrOrchestratorPrompt({
    prNumber: 42,
    repo: "owner/repo",
    comments: SAMPLE_COMMENTS,
    sessionDir: "/tmp/session",
    scriptsDir: "/tmp/scripts",
    config: DEFAULT_FIX_PR_CONFIG,
    iteration: 0,
    skillContent: "# Assessment Skill\nAssess each comment critically.",
  });
}

describe("buildFixPrOrchestratorPrompt", () => {
  test("returns a non-empty string", () => {
    const result = buildDefaultPrompt();
    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
  });

  test("includes PR number and repo", () => {
    const result = buildDefaultPrompt();
    expect(result).toContain("42");
    expect(result).toContain("owner/repo");
  });

  test("includes the comments content", () => {
    const result = buildDefaultPrompt();
    expect(result).toContain("This needs fixing");
    expect(result).toContain("Add error handling");
  });

  test("includes session directory path", () => {
    const result = buildDefaultPrompt();
    expect(result).toContain("/tmp/session");
  });

  test("includes skill content", () => {
    const result = buildDefaultPrompt();
    expect(result).toContain("Assessment Skill");
    expect(result).toContain("Assess each comment critically");
  });

  test("includes receiving review instructions", () => {
    const result = buildDefaultPrompt();
    expect(result.toLowerCase()).toContain("verify before implementing");
  });

  test("includes assessment step", () => {
    const result = buildDefaultPrompt();
    expect(result.toLowerCase()).toContain("assess");
    expect(result.toLowerCase()).toContain("verdict");
    expect(result).toContain("ACCEPT");
    expect(result).toContain("REJECT");
    expect(result).toContain("INVESTIGATE");
  });

  test("includes grouping step", () => {
    const result = buildDefaultPrompt();
    expect(result.toLowerCase()).toContain("group");
    expect(result.toLowerCase()).toContain("parallel");
  });

  test("includes plan step", () => {
    const result = buildDefaultPrompt();
    expect(result.toLowerCase()).toContain("plan");
    expect(result.toLowerCase()).toContain("changes");
  });

  test("includes execute step", () => {
    const result = buildDefaultPrompt();
    expect(result.toLowerCase()).toContain("execute");
    expect(result.toLowerCase()).toContain("test");
  });

  test("includes push and loop step", () => {
    const result = buildDefaultPrompt();
    expect(result).toContain("git push");
    expect(result).toContain("wait-and-check");
  });

  test("includes script paths", () => {
    const result = buildDefaultPrompt();
    expect(result).toContain("/tmp/scripts");
    expect(result).toContain("fetch-pr-comments.sh");
    expect(result).toContain("diff-comments.sh");
    expect(result).toContain("trigger-review.sh");
    expect(result).toContain("wait-and-check.sh");
  });

  test("includes iteration info", () => {
    const result = buildDefaultPrompt();
    expect(result).toContain("0");
    expect(result).toContain("3"); // maxIterations
  });

  test("includes comment reply policy", () => {
    const result = buildDefaultPrompt();
    expect(result.toLowerCase()).toContain("reply");
    expect(result).toContain("answer-selective");
  });

  test("includes reply instructions via gh api", () => {
    const result = buildDefaultPrompt();
    expect(result).toContain("gh api");
    expect(result).toContain("replies");
  });

  test("includes model guidance", () => {
    const result = buildDefaultPrompt();
    expect(result.toLowerCase()).toContain("model");
    expect(result.toLowerCase()).toContain("orchestrator");
    expect(result.toLowerCase()).toContain("planner");
    expect(result.toLowerCase()).toContain("fixer");
  });

  test("includes ripple effect analysis", () => {
    const result = buildDefaultPrompt();
    expect(result.toLowerCase()).toContain("ripple");
  });

  test("adjusts reply instructions based on policy", () => {
    const noAnswer = buildFixPrOrchestratorPrompt({
      prNumber: 42,
      repo: "owner/repo",
      comments: SAMPLE_COMMENTS,
      sessionDir: "/tmp/session",
      scriptsDir: "/tmp/scripts",
      config: { ...DEFAULT_FIX_PR_CONFIG, commentPolicy: "no-answer" },
      iteration: 0,
      skillContent: "",
    });
    expect(noAnswer.toLowerCase()).toContain("do not reply");
  });
});
