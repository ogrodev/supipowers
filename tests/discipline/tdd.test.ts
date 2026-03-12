import { describe, test, expect } from "vitest";
import { buildTddInstructions } from "../../src/discipline/tdd.js";

describe("buildTddInstructions", () => {
  test("returns a non-empty string", () => {
    const result = buildTddInstructions();
    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
  });

  test("includes iron law about no production code without failing test", () => {
    const result = buildTddInstructions();
    expect(result.toLowerCase()).toContain("no production code without a failing test");
  });

  test("includes red-green-refactor cycle", () => {
    const result = buildTddInstructions();
    expect(result).toContain("RED");
    expect(result).toContain("GREEN");
    expect(result).toContain("REFACTOR");
  });

  test("includes mandatory verification steps", () => {
    const result = buildTddInstructions();
    expect(result.toLowerCase()).toContain("watch it fail");
    expect(result.toLowerCase()).toContain("watch it pass");
  });

  test("includes minimal code guidance", () => {
    const result = buildTddInstructions();
    expect(result.toLowerCase()).toContain("minimal");
    expect(result.toLowerCase()).toContain("simplest");
  });

  test("includes red flags for rationalization", () => {
    const result = buildTddInstructions();
    expect(result.toLowerCase()).toContain("code before test");
    expect(result.toLowerCase()).toContain("test passes immediately");
  });

  test("includes verification checklist", () => {
    const result = buildTddInstructions();
    expect(result.toLowerCase()).toContain("every new function");
    expect(result.toLowerCase()).toContain("edge cases");
  });

  test("includes anti-pattern guidance about mocks", () => {
    const result = buildTddInstructions();
    expect(result.toLowerCase()).toContain("mock");
    expect(result.toLowerCase()).toContain("real");
  });

  test("includes when-stuck guidance", () => {
    const result = buildTddInstructions();
    expect(result.toLowerCase()).toContain("stuck");
    expect(result.toLowerCase()).toContain("simplify");
  });

  test("includes bug fix example flow", () => {
    const result = buildTddInstructions();
    expect(result.toLowerCase()).toContain("bug");
    expect(result.toLowerCase()).toContain("failing test");
  });
});
