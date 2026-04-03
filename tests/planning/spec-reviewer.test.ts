
import { buildSpecReviewerPrompt } from "../../src/planning/spec-reviewer.js";

describe("spec reviewer prompt", () => {
  test("includes the spec file path", () => {
    const prompt = buildSpecReviewerPrompt("/path/to/spec.md");
    expect(prompt).toContain("/path/to/spec.md");
  });

  test("includes completeness check", () => {
    const prompt = buildSpecReviewerPrompt("/path/to/spec.md");
    expect(prompt).toContain("Completeness");
    expect(prompt).toContain("TODO");
  });

  test("includes consistency check", () => {
    const prompt = buildSpecReviewerPrompt("/path/to/spec.md");
    expect(prompt).toContain("Consistency");
  });

  test("includes YAGNI check", () => {
    const prompt = buildSpecReviewerPrompt("/path/to/spec.md");
    expect(prompt).toContain("YAGNI");
  });

  test("includes architecture check", () => {
    const prompt = buildSpecReviewerPrompt("/path/to/spec.md");
    expect(prompt).toContain("Architecture");
    expect(prompt).toContain("boundaries");
  });

  test("includes output format with Approved/Issues Found", () => {
    const prompt = buildSpecReviewerPrompt("/path/to/spec.md");
    expect(prompt).toContain("Approved");
    expect(prompt).toContain("Issues Found");
  });

  test("includes scope check", () => {
    const prompt = buildSpecReviewerPrompt("/path/to/spec.md");
    expect(prompt).toContain("Scope");
  });
});
