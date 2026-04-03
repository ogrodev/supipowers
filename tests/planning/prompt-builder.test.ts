
import {
  buildPlanningPrompt,
  buildQuickPlanPrompt,
} from "../../src/planning/prompt-builder.js";

describe("planning prompt builder", () => {
  describe("buildPlanningPrompt (full brainstorming flow)", () => {
    test("includes project context exploration phase", () => {
      const prompt = buildPlanningPrompt({ dotDirDisplay: ".omp" });
      expect(prompt).toContain("project context");
    });

    test("includes user topic when provided", () => {
      const prompt = buildPlanningPrompt({ topic: "auth system", dotDirDisplay: ".omp" });
      expect(prompt).toContain("auth system");
    });

    test("asks user what to build when no topic", () => {
      const prompt = buildPlanningPrompt({ dotDirDisplay: ".omp" });
      expect(prompt).toContain("Ask the user what they want to build");
    });

    test("includes one-question-at-a-time instruction", () => {
      const prompt = buildPlanningPrompt({ dotDirDisplay: ".omp" });
      expect(prompt).toContain("one question at a time");
    });

    test("includes multiple choice preference", () => {
      const prompt = buildPlanningPrompt({ dotDirDisplay: ".omp" });
      expect(prompt).toContain("multiple choice");
    });

    test("includes 2-3 approaches phase", () => {
      const prompt = buildPlanningPrompt({ dotDirDisplay: ".omp" });
      expect(prompt).toContain("2-3 approaches");
      expect(prompt).toContain("trade-offs");
      expect(prompt).toContain("recommendation");
    });

    test("includes design presentation phase", () => {
      const prompt = buildPlanningPrompt({ dotDirDisplay: ".omp" });
      expect(prompt).toContain("design");
      expect(prompt).toContain("architecture");
    });

    test("includes spec document writing phase", () => {
      const prompt = buildPlanningPrompt({ dotDirDisplay: ".omp" });
      expect(prompt).toContain(".omp/supipowers/specs/");
      expect(prompt).toContain("design doc");
    });

    test("includes spec review loop phase", () => {
      const prompt = buildPlanningPrompt({ dotDirDisplay: ".omp" });
      expect(prompt).toContain("spec review");
      expect(prompt).toContain("sub-agent");
    });

    test("includes user review gate", () => {
      const prompt = buildPlanningPrompt({ dotDirDisplay: ".omp" });
      expect(prompt).toContain("review the spec");
      expect(prompt).toContain("before proceeding");
    });

    test("includes handoff to plan writing", () => {
      const prompt = buildPlanningPrompt({ dotDirDisplay: ".omp" });
      expect(prompt).toContain("implementation plan");
    });

    test("includes scope decomposition guidance", () => {
      const prompt = buildPlanningPrompt({ dotDirDisplay: ".omp" });
      expect(prompt).toContain("decompose");
    });

    test("includes YAGNI principle", () => {
      const prompt = buildPlanningPrompt({ dotDirDisplay: ".omp" });
      expect(prompt).toContain("YAGNI");
    });

    test("appends skill content when provided", () => {
      const prompt = buildPlanningPrompt({ skillContent: "Custom planning rules here", dotDirDisplay: ".omp" });
      expect(prompt).toContain("Custom planning rules here");
    });

    test("includes spec reviewer prompt template", () => {
      const prompt = buildPlanningPrompt({ dotDirDisplay: ".omp" });
      expect(prompt).toContain("spec-document-reviewer");
    });

    test("includes max 5 iterations guidance for review loop", () => {
      const prompt = buildPlanningPrompt({ dotDirDisplay: ".omp" });
      expect(prompt).toContain("5");
    });

    test("does not have duplicate 'after the spec review loop' text", () => {
      const prompt = buildPlanningPrompt({ dotDirDisplay: ".omp" });
      const matches = prompt.match(/After the spec review loop passes/g);
      expect(matches).toHaveLength(1);
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
      expect(prompt).toContain("complexity");
    });

    test("appends skill content when provided", () => {
      const prompt = buildQuickPlanPrompt("task", "Custom rules");
      expect(prompt).toContain("Custom rules");
    });

    test("includes YAML frontmatter example", () => {
      const prompt = buildQuickPlanPrompt("add user auth");
      expect(prompt).toContain("```yaml");
      expect(prompt).toContain("name: <feature-name>");
      expect(prompt).toContain("created: YYYY-MM-DD");
      expect(prompt).toContain("tags: [tag1, tag2]");
    });
  });
});
