import { describe, test, expect } from "vitest";
import { buildExecutionPrompt } from "../../../src/qa/phases/execution.js";
import type { QaSessionLedger } from "../../../src/types.js";

function makeLedger(overrides: Partial<QaSessionLedger> = {}): QaSessionLedger {
  return {
    id: "qa-test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    framework: "vitest",
    phases: {
      discovery: { status: "completed" },
      matrix: { status: "completed" },
      execution: { status: "pending" },
      reporting: { status: "pending" },
    },
    tests: [
      { id: "t1", filePath: "a.test.ts", testName: "test one" },
      { id: "t2", filePath: "b.test.ts", testName: "test two" },
    ],
    matrix: [],
    results: [],
    ...overrides,
  };
}

describe("execution phase prompt", () => {
  test("full run includes all test cases", () => {
    const ledger = makeLedger();
    const prompt = buildExecutionPrompt(ledger);
    expect(prompt).toContain("t1");
    expect(prompt).toContain("t2");
    expect(prompt).toContain("a.test.ts");
    expect(prompt).toContain("b.test.ts");
  });

  test("full run includes framework command", () => {
    const ledger = makeLedger();
    const prompt = buildExecutionPrompt(ledger);
    expect(prompt).toContain("vitest");
  });

  test("failed-only run includes only specified failed tests", () => {
    const failedTests = [{ id: "t2", filePath: "b.test.ts", testName: "test two" }];
    const prompt = buildExecutionPrompt(makeLedger(), { failedOnly: true, failedTests });
    expect(prompt).toContain("t2");
    expect(prompt).toContain("b.test.ts");
    expect(prompt).toContain("failed");
  });

  test("requests structured JSON output", () => {
    const prompt = buildExecutionPrompt(makeLedger());
    expect(prompt).toContain("testId");
    expect(prompt).toContain("status");
    expect(prompt).toContain("JSON");
  });

  test("includes auto-chain instruction", () => {
    const prompt = buildExecutionPrompt(makeLedger());
    expect(prompt).toContain("/supi:qa");
  });
});
