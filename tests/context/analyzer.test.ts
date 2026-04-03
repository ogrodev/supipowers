import { describe, test, expect } from "vitest";
import { estimateTokens, formatSize, parseSystemPrompt } from "../../src/context/analyzer.js";
import type { PromptSection } from "../../src/context/analyzer.js";

describe("estimateTokens", () => {
  test("returns chars / 4 ceiling for normal text", () => {
    expect(estimateTokens("hello world")).toBe(3); // 11 chars / 4 = 2.75 → 3
  });

  test("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  test("handles single character", () => {
    expect(estimateTokens("a")).toBe(1);
  });
});

describe("formatSize", () => {
  test("formats bytes to KB with 1 decimal for < 10KB", () => {
    expect(formatSize(5120)).toBe("5.0KB");
  });

  test("formats bytes to KB rounded for >= 10KB", () => {
    expect(formatSize(14336)).toBe("14KB");
  });

  test("returns 0KB for 0 bytes", () => {
    expect(formatSize(0)).toBe("0KB");
  });

  test("formats large values", () => {
    expect(formatSize(131072)).toBe("128KB");
  });
});


describe("parseSystemPrompt", () => {
  test("returns empty array for empty string", () => {
    expect(parseSystemPrompt("")).toEqual([]);
  });

  test("extracts AGENTS.md file section", () => {
    const prompt = `Some preamble\n<file path="/project/AGENTS.md">\n# My Project\nSome content\n</file>\nSome postamble`;
    const sections = parseSystemPrompt(prompt);
    const agents = sections.find((s) => s.label === "AGENTS.md");
    expect(agents).toBeDefined();
    expect(agents!.content).toContain("# My Project");
    expect(agents!.bytes).toBeGreaterThan(0);
  });

  test("extracts generic file sections by basename", () => {
    const prompt = `<file path="/project/src/types.ts">\nexport type Foo = string;\n</file>`;
    const sections = parseSystemPrompt(prompt);
    const fileSection = sections.find((s) => s.label === "File: types.ts");
    expect(fileSection).toBeDefined();
  });

  test("extracts skills section with count", () => {
    const prompt = `<skills>\n<skill name="planning">Plan content</skill>\n<skill name="review">Review content</skill>\n</skills>`;
    const sections = parseSystemPrompt(prompt);
    const skills = sections.find((s) => s.label === "Skills (2)");
    expect(skills).toBeDefined();
    expect(skills!.bytes).toBeGreaterThan(0);
  });

  test("extracts instructions section", () => {
    const prompt = `<instructions>\nDo this and that\n</instructions>`;
    const sections = parseSystemPrompt(prompt);
    expect(sections.find((s) => s.label === "Extension instructions")).toBeDefined();
  });

  test("extracts project section", () => {
    const prompt = `<project>\n## Context\nProject info\n</project>`;
    const sections = parseSystemPrompt(prompt);
    expect(sections.find((s) => s.label === "Project context")).toBeDefined();
  });

  test("collects unmatched text as Base system prompt", () => {
    const prompt = `You are a helpful assistant.\n<file path="/AGENTS.md">\ncontent\n</file>\nMore instructions here.`;
    const sections = parseSystemPrompt(prompt);
    const base = sections.find((s) => s.label === "Base system prompt");
    expect(base).toBeDefined();
    expect(base!.content).toContain("You are a helpful assistant.");
    expect(base!.content).toContain("More instructions here.");
  });

  test("returns single Base entry for prompt with no recognized sections", () => {
    const prompt = "Just a plain system prompt with no special sections.";
    const sections = parseSystemPrompt(prompt);
    expect(sections).toHaveLength(1);
    expect(sections[0].label).toBe("Base system prompt");
  });
});