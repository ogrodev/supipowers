import { buildPlanningSystemPrompt } from "../../src/planning/system-prompt.js";

describe("planning system prompt", () => {
  const basePrompt = [
    "<role>",
    "Base prompt",
    "</role>",
    "",
    "# Skills",
    "base skill content",
    "# Tools",
    "tool list",
    "",
    "═══════════Rules═══════════",
    "base rules",
    "",
    "═══════════Now═══════════",
    "<critical>",
    "base critical block",
    "</critical>",
  ].join("\n");

  test("includes shared plan-content policy in full planning mode", () => {
    const prompt = buildPlanningSystemPrompt(basePrompt, {
      dotDirDisplay: ".omp",
      skillContent: "Additional planning note.",
    });

    expect(prompt).toContain("Plans describe the work — they do not generate it.");
    expect(prompt).toContain("Additional planning note.");
  });

  test("includes quick-plan content guidance", () => {
    const prompt = buildPlanningSystemPrompt(basePrompt, {
      dotDirDisplay: ".omp",
      isQuick: true,
    });

    expect(prompt).toContain("Describe what each task changes in prose.");
    expect(prompt).toContain("full function bodies, full test bodies, or file-content dumps");
  });
});
