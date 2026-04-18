import { describe, expect, test } from "bun:test";
import { buildValidationPrompt } from "../../src/review/validator.js";
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
    id: "F001",
    title: "Null deref",
    severity: "error",
    priority: "P1",
    confidence: 0.8,
    file: "src/x.ts",
    lineStart: 5,
    lineEnd: 7,
    body: "Body",
    suggestion: null,
    agent: "correctness",
  } as any,
];

describe("buildValidationPrompt", () => {
  test("embeds validator metadata", () => {
    const prompt = buildValidationPrompt(SCOPE, FINDINGS, "validator-xyz", "2026-04-17T00:00:00.000Z");
    expect(prompt).toContain("validator-xyz");
    expect(prompt).toContain("2026-04-17T00:00:00.000Z");
  });

  test("includes rendered canonical ReviewOutput schema (drift detection)", () => {
    const prompt = buildValidationPrompt(SCOPE, FINDINGS, "validator", "2026-04-17T00:00:00.000Z");

    expect(prompt).toContain("findings:");
    expect(prompt).toContain("status:");
    expect(prompt).toContain('"confirmed"');
    expect(prompt).toContain('"rejected"');
    expect(prompt).toContain('"uncertain"');
  });

  test("serializes findings as JSON in the prompt", () => {
    const prompt = buildValidationPrompt(SCOPE, FINDINGS, "validator", "2026-04-17T00:00:00.000Z");
    expect(prompt).toContain('"id": "F001"');
    expect(prompt).toContain('"title": "Null deref"');
  });
});
