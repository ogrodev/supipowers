import { describe, expect, test } from "bun:test";
import { parseReviewOutput, explainReviewOutputFailure } from "../../src/review/output.js";

const VALID_OUTPUT = {
  findings: [
    {
      id: "F001",
      title: "Null deref",
      severity: "error",
      priority: "P1",
      confidence: 0.9,
      file: "src/x.ts",
      lineStart: 10,
      lineEnd: 12,
      body: "Dereference without null guard.",
      suggestion: "Add guard.",
      agent: "correctness",
    },
  ],
  summary: "1 finding",
  status: "failed",
};

describe("parseReviewOutput", () => {
  test("returns parsed ReviewOutput on valid JSON that matches the schema", () => {
    const raw = JSON.stringify(VALID_OUTPUT);
    const result = parseReviewOutput(raw);
    expect(result).not.toBeNull();
    expect(result?.findings.length).toBe(1);
    expect(result?.status).toBe("failed");
  });

  test("strips markdown code fences", () => {
    const raw = "```json\n" + JSON.stringify(VALID_OUTPUT) + "\n```";
    const result = parseReviewOutput(raw);
    expect(result).not.toBeNull();
  });

  test("returns null on invalid JSON", () => {
    expect(parseReviewOutput("nope")).toBeNull();
  });

  test("returns null when schema mismatch (missing required field)", () => {
    const raw = JSON.stringify({ findings: [], summary: "x" });
    expect(parseReviewOutput(raw)).toBeNull();
  });

  test("returns null when status is not one of the allowed values", () => {
    const raw = JSON.stringify({ ...VALID_OUTPUT, status: "bogus" });
    expect(parseReviewOutput(raw)).toBeNull();
  });
});

describe("explainReviewOutputFailure", () => {
  test("returns null when output is valid", () => {
    const raw = JSON.stringify(VALID_OUTPUT);
    expect(explainReviewOutputFailure(raw)).toBeNull();
  });

  test("returns human-readable message when JSON is malformed", () => {
    const err = explainReviewOutputFailure("not json");
    expect(err).not.toBeNull();
    expect(err).toContain("Invalid JSON");
  });

  test("returns path-scoped validation message on schema mismatch", () => {
    const raw = JSON.stringify({ ...VALID_OUTPUT, findings: "should be array" });
    const err = explainReviewOutputFailure(raw);
    expect(err).not.toBeNull();
    expect(err).toContain("findings");
  });
});
