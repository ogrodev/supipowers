
import { buildPlanWriterPrompt } from "../../src/planning/plan-writer-prompt.js";

describe("plan writer prompt", () => {
  const specPath = ".omp/supipowers/specs/2026-03-12-auth-design.md";
  const dotDirDisplay = ".omp";

  describe("structure", () => {
    test("includes scope check", () => {
      const prompt = buildPlanWriterPrompt({ specPath, dotDirDisplay });
      expect(prompt).toContain("Scope Check");
      expect(prompt).toContain("subsystem");
    });

    test("includes file structure mapping phase", () => {
      const prompt = buildPlanWriterPrompt({ specPath, dotDirDisplay });
      expect(prompt).toContain("file structure");
      expect(prompt).toContain("created or modified");
    });

    test("includes plan document header template", () => {
      const prompt = buildPlanWriterPrompt({ specPath, dotDirDisplay });
      expect(prompt).toContain("Goal:");
      expect(prompt).toContain("Architecture:");
      expect(prompt).toContain("Tech Stack:");
    });

    test("includes bite-sized task granularity", () => {
      const prompt = buildPlanWriterPrompt({ specPath, dotDirDisplay });
      expect(prompt).toContain("2-5 minutes");
      expect(prompt).toContain("bite-sized");
    });

    test("includes TDD task structure", () => {
      const prompt = buildPlanWriterPrompt({ specPath, dotDirDisplay });
      expect(prompt).toContain("failing test");
      expect(prompt).toContain("verify it fails");
      expect(prompt).toContain("minimal implementation");
      expect(prompt).toContain("verify it passes");
      expect(prompt).toContain("Commit");
    });

    test("includes checkbox syntax", () => {
      const prompt = buildPlanWriterPrompt({ specPath, dotDirDisplay });
      expect(prompt).toContain("- [ ]");
    });

    test("includes exact code requirement", () => {
      const prompt = buildPlanWriterPrompt({ specPath, dotDirDisplay });
      expect(prompt).toContain("exact");
      expect(prompt).toContain("Complete code");
    });
  });

  describe("review loop", () => {
    test("includes plan review loop instructions", () => {
      const prompt = buildPlanWriterPrompt({ specPath, dotDirDisplay });
      expect(prompt).toContain("plan review");
      expect(prompt).toContain("plan-document-reviewer");
    });

    test("includes chunk boundaries guidance", () => {
      const prompt = buildPlanWriterPrompt({ specPath, dotDirDisplay });
      expect(prompt).toContain("Chunk");
      expect(prompt).toContain("1000 lines");
    });

    test("includes max 5 iterations for review loop", () => {
      const prompt = buildPlanWriterPrompt({ specPath, dotDirDisplay });
      expect(prompt).toContain("5 iterations");
    });

    test("includes spec path for reviewer reference", () => {
      const prompt = buildPlanWriterPrompt({ specPath, dotDirDisplay });
      expect(prompt).toContain(specPath);
    });
  });

  describe("execution handoff", () => {
    test("includes execution handoff", () => {
      const prompt = buildPlanWriterPrompt({ specPath, dotDirDisplay });
      expect(prompt).toContain("Review it and approve when ready");
    });

    test("includes save location", () => {
      const prompt = buildPlanWriterPrompt({ specPath, dotDirDisplay });
      expect(prompt).toContain(".omp/supipowers/plans/");
    });
  });

  describe("principles", () => {
    test("includes DRY, YAGNI, TDD", () => {
      const prompt = buildPlanWriterPrompt({ specPath, dotDirDisplay });
      expect(prompt).toContain("DRY");
      expect(prompt).toContain("YAGNI");
      expect(prompt).toContain("TDD");
    });

    test("includes file responsibility guidance", () => {
      const prompt = buildPlanWriterPrompt({ specPath, dotDirDisplay });
      expect(prompt).toContain("one clear responsibility");
    });
  });

  describe("plan review loop", () => {
    test("includes reviewer dispatch instructions", () => {
      const prompt = buildPlanWriterPrompt({ specPath, dotDirDisplay });
      expect(prompt).toContain("plan-document-reviewer sub-agent");
      expect(prompt).toContain("completeness, spec alignment, task decomposition");
      expect(prompt).toContain("plan file path, the spec file path, and the chunk number");
    });

    test("does not embed the full reviewer prompt", () => {
      const prompt = buildPlanWriterPrompt({ specPath, dotDirDisplay });
      // The old pattern embedded a full reviewer prompt with a placeholder path
      expect(prompt).not.toContain("<plan-file-path>");
    });
  });
});
