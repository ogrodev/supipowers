import { describe, expect, test } from "vitest";
import { buildQaFindingsReport, deriveQaRecommendation } from "../../src/qa/report";
import type { QaExecutionSummary } from "../../src/qa/types";

const baseSummary: QaExecutionSummary = {
  runId: "qa-1",
  workflow: "checkout",
  targetUrl: "http://localhost:3000",
  recommendation: "APPROVE",
  finalVerdict: "APPROVE",
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  notesFilePath: ".pi/supipowers/qa-runs/qa-1/findings.md",
  matrix: {
    workflow: "checkout",
    targetUrl: "http://localhost:3000",
    generatedAt: new Date().toISOString(),
    cases: [],
  },
  results: [
    {
      caseId: "QA-1",
      title: "Happy path",
      severity: "high",
      passed: true,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      screenshots: ["QA-1-start.png", "QA-1-end.png"],
      commands: [],
    },
  ],
};

describe("qa report", () => {
  test("derives refusal on high-severity failure", () => {
    const recommendation = deriveQaRecommendation([
      {
        caseId: "QA-1",
        title: "Happy path",
        severity: "high",
        passed: false,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        screenshots: [],
        commands: [],
      },
    ]);

    expect(recommendation).toBe("REFUSE");
  });

  test("renders findings markdown", () => {
    const report = buildQaFindingsReport(baseSummary);
    expect(report).toContain("# QA Findings — qa-1");
    expect(report).toContain("Final verdict: APPROVE");
    expect(report).toContain("screenshots/QA-1-start.png");
  });
});
