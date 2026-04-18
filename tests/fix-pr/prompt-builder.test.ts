import { buildFixPrOrchestratorPrompt } from "../../src/fix-pr/prompt-builder.js";
import { DEFAULT_FIX_PR_CONFIG } from "../../src/fix-pr/config.js";
import type { FixPrAssessmentBatch, FixPrWorkBatch } from "../../src/fix-pr/contracts.js";

const SAMPLE_COMMENTS = '{"id":1,"path":"src/foo.ts","line":10,"body":"This needs fixing","user":"reviewer"}\n{"id":2,"path":"src/bar.ts","line":20,"body":"Add error handling","user":"reviewer"}';

const SAMPLE_ASSESSMENT: FixPrAssessmentBatch = {
  assessments: [
    {
      commentId: 1,
      verdict: "apply",
      rationale: "Matches actual code behaviour.",
      affectedFiles: ["src/foo.ts"],
      rippleEffects: [],
      verificationPlan: "bun test src/foo.test.ts",
    },
    {
      commentId: 2,
      verdict: "reject",
      rationale: "Reviewer misread the diff.",
      affectedFiles: [],
      rippleEffects: [],
      verificationPlan: "N/A",
    },
  ],
};

const SAMPLE_BATCHES: FixPrWorkBatch[] = [
  { id: "batch-1", commentIds: [1], affectedFiles: ["src/foo.ts"] },
];

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
    taskModel: "claude-sonnet-4-6",
    selectedTargetLabel: "@repo/pkg — packages/pkg",
    deferredCommentsSummary: null,
    assessment: SAMPLE_ASSESSMENT,
    workBatches: SAMPLE_BATCHES,
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

  test("includes assessment step referencing the validated artifact", () => {
    const result = buildDefaultPrompt();
    expect(result.toLowerCase()).toContain("assess");
    expect(result.toLowerCase()).toContain("verdict");
    expect(result).toContain("FixPrAssessmentBatchSchema");
    expect(result).toContain('"verdict": "apply"');
    expect(result).toContain('"verdict": "reject"');
  });

  test("includes grouping step with work batches", () => {
    const result = buildDefaultPrompt();
    expect(result.toLowerCase()).toContain("group");
    expect(result.toLowerCase()).toContain("parallel");
    expect(result).toContain("batch-1");
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

  test("includes push and loop step with portable runners", () => {
    const result = buildDefaultPrompt();
    expect(result).toContain("git push");
    expect(result).toContain('bun "/tmp/scripts/wait-and-check.ts"');
    expect(result).not.toContain("wait-and-check.sh");
  });

  test("includes runner paths instead of shell script paths", () => {
    const result = buildDefaultPrompt();
    expect(result).toContain("/tmp/scripts");
    expect(result).toContain("trigger-review.ts");
    expect(result).toContain("wait-and-check.ts");
    expect(result).not.toContain("fetch-pr-comments.sh");
    expect(result).not.toContain("diff-comments.sh");
    expect(result).not.toContain("trigger-review.sh");
    expect(result).not.toContain("wait-and-check.sh");
  });

  test("includes iteration info", () => {
    const result = buildDefaultPrompt();
    expect(result).toContain("0");
    expect(result).toContain("3");
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
      taskModel: "claude-sonnet-4-6",
      selectedTargetLabel: "@repo/pkg — packages/pkg",
      deferredCommentsSummary: "2 comments deferred to repo root",
      assessment: SAMPLE_ASSESSMENT,
      workBatches: SAMPLE_BATCHES,
    });
    expect(noAnswer.toLowerCase()).toContain("do not reply");
  });
});
