import { describe, expect, test } from "bun:test";
import { buildSingleReviewPrompt } from "../../src/review/runner.js";
import type { ReviewScope } from "../../src/types.js";

const SCOPE: ReviewScope = {
  mode: "pull-request",
  description: "PR #42",
  baseBranch: "main",
  commit: null,
  customInstructions: null,
  diff: "diff --git a/x b/x\n",
  files: [
    { path: "src/x.ts", status: "modified", additions: 5, deletions: 2 },
  ],
  stats: {
    filesChanged: 1,
    excludedFiles: 0,
    additions: 5,
    deletions: 2,
  },
} as any;

describe("buildSingleReviewPrompt", () => {
  test("includes rendered canonical ReviewOutput schema (drift detection)", () => {
    const prompt = buildSingleReviewPrompt(SCOPE, "quick");

    // Schema-derived structure, not hand-maintained example:
    expect(prompt).toContain("findings:");
    expect(prompt).toContain("summary: string;");
    expect(prompt).toContain('"passed"');
    expect(prompt).toContain('"failed"');
    expect(prompt).toContain('"blocked"');
    expect(prompt).toContain('"error"');
    expect(prompt).toContain('"warning"');
    expect(prompt).toContain('"info"');
  });

  test("scales rules section to review level", () => {
    const quickPrompt = buildSingleReviewPrompt(SCOPE, "quick");
    const deepPrompt = buildSingleReviewPrompt(SCOPE, "deep");

    expect(quickPrompt).toContain("higher-confidence findings");
    expect(deepPrompt).toContain("Review deeply");
  });

  test("embeds the diff", () => {
    const prompt = buildSingleReviewPrompt(SCOPE, "quick");
    expect(prompt).toContain("diff --git a/x b/x");
  });
});
