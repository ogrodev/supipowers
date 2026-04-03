
import { buildVerificationInstructions } from "../../src/discipline/verification.js";

describe("buildVerificationInstructions", () => {
  test("returns a non-empty string", () => {
    const result = buildVerificationInstructions();
    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
  });

  test("includes iron law about no completion claims without verification", () => {
    const result = buildVerificationInstructions();
    expect(result.toLowerCase()).toContain("no completion claims without");
    expect(result.toLowerCase()).toContain("verification");
  });

  test("includes the gate function steps", () => {
    const result = buildVerificationInstructions();
    expect(result.toLowerCase()).toContain("identify");
    expect(result.toLowerCase()).toContain("run");
    expect(result.toLowerCase()).toContain("read");
    expect(result.toLowerCase()).toContain("verify");
  });

  test("includes common failure patterns", () => {
    const result = buildVerificationInstructions();
    expect(result.toLowerCase()).toContain("tests pass");
    expect(result.toLowerCase()).toContain("build succeeds");
    expect(result.toLowerCase()).toContain("bug fixed");
  });

  test("includes red flags for premature claims", () => {
    const result = buildVerificationInstructions();
    expect(result.toLowerCase()).toContain("should");
    expect(result.toLowerCase()).toContain("probably");
    expect(result.toLowerCase()).toContain("done!");
  });

  test("includes evidence-before-assertions principle", () => {
    const result = buildVerificationInstructions();
    expect(result.toLowerCase()).toContain("evidence");
    expect(result.toLowerCase()).toContain("claim");
  });

  test("includes requirements verification", () => {
    const result = buildVerificationInstructions();
    expect(result.toLowerCase()).toContain("requirements");
    expect(result.toLowerCase()).toContain("checklist");
  });

  test("includes agent delegation verification", () => {
    const result = buildVerificationInstructions();
    expect(result.toLowerCase()).toContain("agent");
    expect(result.toLowerCase()).toContain("trust");
  });

  test("includes regression test red-green verification", () => {
    const result = buildVerificationInstructions();
    expect(result.toLowerCase()).toContain("regression");
    expect(result.toLowerCase()).toContain("red-green");
  });

  test("warns against satisfaction expressions before verification", () => {
    const result = buildVerificationInstructions();
    expect(result.toLowerCase()).toContain("great!");
    expect(result.toLowerCase()).toContain("perfect!");
  });
});
