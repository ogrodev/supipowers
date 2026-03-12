import { describe, test, expect } from "vitest";
import {
  buildPlanningPrompt,
  buildQuickPlanPrompt,
} from "../../src/planning/prompt-builder.js";

describe("planning prompt builder", () => {
  describe("buildPlanningPrompt (full brainstorming flow)", () => {
    test("includes project context exploration phase", () => {
      const prompt = buildPlanningPrompt({});
      expect(prompt).toContain("project context");
    });

    test("includes user topic when provided", () => {
      const prompt = buildPlanningPrompt({ topic: "auth system" });
      expect(prompt).toContain("auth system");
    });

    test("asks user what to build when no topic", () => {
      const prompt = buildPlanningPrompt({});
      expect(prompt).toContain("Ask the user what they want to build");
    });

    test("includes one-question-at-a-time instruction", () => {
      const prompt = buildPlanningPrompt({});
      expect(prompt).toContain("one question at a time");
    });

    test("includes multiple choice preference", () => {
      const prompt = buildPlanningPrompt({});
      expect(prompt).toContain("multiple choice");
    });

    test("includes 2-3 approaches phase", () => {
      const prompt = buildPlanningPrompt({});
      expect(prompt).toContain("2-3 approaches");
      expect(prompt).toContain("trade-offs");
      expect(prompt).toContain("recommendation");
    });

    test("includes design presentation phase", () => {
      const prompt = buildPlanningPrompt({});
      expect(prompt).toContain("design");
      expect(prompt).toContain("architecture");
    });

    test("includes spec document writing phase", () => {
      const prompt = buildPlanningPrompt({});
      expect(prompt).toContain("docs/supipowers/specs/");
      expect(prompt).toContain("design doc");
    });

    test("includes spec review loop phase", () => {
      const prompt = buildPlanningPrompt({});
      expect(prompt).toContain("spec review");
      expect(prompt).toContain("sub-agent");
    });

    test("includes user review gate", () => {
      const prompt = buildPlanningPrompt({});
      expect(prompt).toContain("review the spec");
      expect(prompt).toContain("before proceeding");
    });

    test("includes handoff to plan writing", () => {
      const prompt = buildPlanningPrompt({});
      expect(prompt).toContain("implementation plan");
    });

    test("includes scope decomposition guidance", () => {
      const prompt = buildPlanningPrompt({});
      expect(prompt).toContain("decompose");
    });

    test("includes YAGNI principle", () => {
      const prompt = buildPlanningPrompt({});
      expect(prompt).toContain("YAGNI");
    });

    test("appends skill content when provided", () => {
      const prompt = buildPlanningPrompt({ skillContent: "Custom planning rules here" });
      expect(prompt).toContain("Custom planning rules here");
    });

    test("includes spec reviewer prompt template", () => {
      const prompt = buildPlanningPrompt({});
      expect(prompt).toContain("spec-document-reviewer");
    });

    test("includes max 5 iterations guidance for review loop", () => {
      const prompt = buildPlanningPrompt({});
      expect(prompt).toContain("5");
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

    test("includes plan format", () => {
      const prompt = buildQuickPlanPrompt("add user auth");
      expect(prompt).toContain("YAML frontmatter");
      expect(prompt).toContain("parallel-safe");
    });

    test("appends skill content when provided", () => {
      const prompt = buildQuickPlanPrompt("task", "Custom rules");
      expect(prompt).toContain("Custom rules");
    });
  });
});
