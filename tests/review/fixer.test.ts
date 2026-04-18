import { describe, expect, test } from "bun:test";
import { buildFixPrompt } from "../../src/review/fixer.js";
import type { ReviewFinding, ReviewScope } from "../../src/types.js";

const SCOPE: ReviewScope = {
  mode: "pull-request",
  description: "PR #7",
  baseBranch: "main",
  commit: null,
  customInstructions: null,
  diff: "",
  files: [],
  stats: { filesChanged: 0, excludedFiles: 0, additions: 0, deletions: 0 },
} as any;

const FINDINGS: ReviewFinding[] = [
  {
    id: "F010",
    title: "Missing await",
    severity: "error",
    priority: "P1",
    confidence: 0.9,
    file: "src/y.ts",
    lineStart: 3,
    lineEnd: 3,
    body: "Floating promise.",
    suggestion: "Add await.",
    agent: "correctness",
  } as any,
];

describe("buildFixPrompt", () => {
  test("includes rendered canonical ReviewFixOutput schema (drift detection)", () => {
    const prompt = buildFixPrompt(SCOPE, FINDINGS);

    expect(prompt).toContain("fixes:");
    expect(prompt).toContain("status:");
    expect(prompt).toContain('"applied"');
    expect(prompt).toContain('"partial"');
    expect(prompt).toContain('"skipped"');
    expect(prompt).toContain('"blocked"');
  });

  test("embeds the findings JSON", () => {
    const prompt = buildFixPrompt(SCOPE, FINDINGS);
    expect(prompt).toContain('"id": "F010"');
    expect(prompt).toContain('"file": "src/y.ts"');
  });
});
