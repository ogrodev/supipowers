import {
  buildPlanningPrompt,
  buildQuickPlanPrompt,
} from "../../src/planning/prompt-builder.js";

describe("planning prompt builder", () => {
  describe("buildPlanningPrompt", () => {
    test("returns topic-based prompt when topic provided", () => {
      const prompt = buildPlanningPrompt({ topic: "auth system" });
      expect(prompt).toContain("auth system");
      expect(prompt).toContain("The user wants to plan");
    });

    test("asks user what to build when no topic", () => {
      const prompt = buildPlanningPrompt({});
      expect(prompt).toBe("Ask the user what they want to build or accomplish.");
    });

    test("asks user what to build when options empty", () => {
      const prompt = buildPlanningPrompt({});
      expect(prompt).toContain("Ask the user what they want to build");
    });
  });

  describe("buildQuickPlanPrompt", () => {
    test("includes task description", () => {
      const prompt = buildQuickPlanPrompt("add user auth");
      expect(prompt).toContain("add user auth");
    });

    test("skips brainstorming", () => {
      const prompt = buildQuickPlanPrompt("add user auth");
      expect(prompt).toContain("Skip brainstorming");
    });

    test("goes straight to task breakdown", () => {
      const prompt = buildQuickPlanPrompt("add user auth");
      expect(prompt).toContain("go straight to task breakdown");
    });

    test("includes concise plan instruction", () => {
      const prompt = buildQuickPlanPrompt("add user auth");
      expect(prompt).toContain("Generate a concise implementation plan");
    });
  });
});
