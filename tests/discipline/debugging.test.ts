import { describe, test, expect } from "vitest";
import { buildDebuggingInstructions } from "../../src/discipline/debugging.js";

describe("buildDebuggingInstructions", () => {
  test("returns a non-empty string", () => {
    const result = buildDebuggingInstructions();
    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
  });

  test("includes iron law about root cause before fixes", () => {
    const result = buildDebuggingInstructions();
    expect(result.toLowerCase()).toContain("root cause");
    expect(result.toLowerCase()).toContain("before");
    expect(result.toLowerCase()).toContain("fix");
  });

  test("includes phase 1: root cause investigation", () => {
    const result = buildDebuggingInstructions();
    expect(result.toLowerCase()).toContain("root cause investigation");
    expect(result.toLowerCase()).toContain("error message");
    expect(result.toLowerCase()).toContain("reproduce");
  });

  test("includes phase 2: pattern analysis", () => {
    const result = buildDebuggingInstructions();
    expect(result.toLowerCase()).toContain("pattern analysis");
    expect(result.toLowerCase()).toContain("working example");
  });

  test("includes phase 3: hypothesis and testing", () => {
    const result = buildDebuggingInstructions();
    expect(result.toLowerCase()).toContain("hypothesis");
    expect(result.toLowerCase()).toContain("single");
    expect(result.toLowerCase()).toContain("one variable");
  });

  test("includes phase 4: implementation", () => {
    const result = buildDebuggingInstructions();
    expect(result.toLowerCase()).toContain("failing test case");
    expect(result.toLowerCase()).toContain("single fix");
  });

  test("includes 3-attempt escalation rule", () => {
    const result = buildDebuggingInstructions();
    expect(result).toContain("3");
    expect(result.toLowerCase()).toContain("stop");
    expect(result.toLowerCase()).toContain("architecture");
  });

  test("includes red flags for rationalization", () => {
    const result = buildDebuggingInstructions();
    expect(result.toLowerCase()).toContain("quick fix");
    expect(result.toLowerCase()).toContain("just try");
  });

  test("includes recent changes check", () => {
    const result = buildDebuggingInstructions();
    expect(result.toLowerCase()).toContain("recent changes");
    expect(result.toLowerCase()).toContain("git diff");
  });

  test("includes data flow tracing", () => {
    const result = buildDebuggingInstructions();
    expect(result.toLowerCase()).toContain("trace");
    expect(result.toLowerCase()).toContain("data flow");
  });
});
