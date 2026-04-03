
import { buildReceivingReviewInstructions } from "../../src/discipline/receiving-review.js";

describe("buildReceivingReviewInstructions", () => {
  test("returns a non-empty string", () => {
    const result = buildReceivingReviewInstructions();
    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
  });

  test("includes the response pattern steps", () => {
    const result = buildReceivingReviewInstructions();
    expect(result).toContain("READ");
    expect(result).toContain("UNDERSTAND");
    expect(result).toContain("VERIFY");
    expect(result).toContain("EVALUATE");
    expect(result).toContain("IMPLEMENT");
  });

  test("forbids performative agreement", () => {
    const result = buildReceivingReviewInstructions();
    expect(result.toLowerCase()).toContain("performative");
    expect(result).toContain("absolutely right");
    expect(result).toContain("Great point");
  });

  test("includes handling unclear feedback", () => {
    const result = buildReceivingReviewInstructions();
    expect(result.toLowerCase()).toContain("unclear");
    expect(result.toLowerCase()).toContain("ask");
    expect(result.toLowerCase()).toContain("clarif");
  });

  test("includes source-specific handling", () => {
    const result = buildReceivingReviewInstructions();
    expect(result.toLowerCase()).toContain("human partner");
    expect(result.toLowerCase()).toContain("external");
  });

  test("includes YAGNI check for suggested features", () => {
    const result = buildReceivingReviewInstructions();
    expect(result.toLowerCase()).toContain("yagni");
    expect(result.toLowerCase()).toContain("unused");
  });

  test("includes implementation order guidance", () => {
    const result = buildReceivingReviewInstructions();
    expect(result.toLowerCase()).toContain("blocking");
    expect(result.toLowerCase()).toContain("simple");
    expect(result.toLowerCase()).toContain("complex");
  });

  test("includes when to push back", () => {
    const result = buildReceivingReviewInstructions();
    expect(result.toLowerCase()).toContain("push back");
    expect(result.toLowerCase()).toContain("technical");
  });

  test("includes verify-before-implementing principle", () => {
    const result = buildReceivingReviewInstructions();
    expect(result.toLowerCase()).toContain("verify before implementing");
  });

  test("includes one-at-a-time implementation", () => {
    const result = buildReceivingReviewInstructions();
    expect(result.toLowerCase()).toContain("one at a time");
    expect(result.toLowerCase()).toContain("test each");
  });
});
