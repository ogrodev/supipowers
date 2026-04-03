import { describe, test, expect } from "vitest";
import { estimateTokens, formatSize, parseSystemPrompt, buildBreakdown } from "../../src/context/analyzer.js";
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

  test("extracts Memory section from heading", () => {
    const prompt = `Some text\n# Memory Guidance\nMemory root: memory://root\nSome memory content\n# Other Section\nOther content`;
    const sections = parseSystemPrompt(prompt);
    const memory = sections.find((s) => s.label === "Memory");
    expect(memory).toBeDefined();
    expect(memory!.content).toContain("Memory root: memory://root");
    expect(memory!.content).not.toContain("Other content");
  });

  test("extracts Routing rules section", () => {
    const prompt = `Preamble\n# context-mode \u2014 MANDATORY routing rules\nYou have context-mode MCP tools\n## Some subsection\nMore rules\n# Next Top Section\nDone`;
    const sections = parseSystemPrompt(prompt);
    const routing = sections.find((s) => s.label === "Routing rules");
    expect(routing).toBeDefined();
    expect(routing!.content).toContain("context-mode MCP tools");
  });

  test("extracts MCP instructions section", () => {
    const prompt = `Before\n## MCP Server Instructions\nThe following instructions\n## Another Section\nAfter`;
    const sections = parseSystemPrompt(prompt);
    const mcp = sections.find((s) => s.label === "MCP instructions");
    expect(mcp).toBeDefined();
    expect(mcp!.content).toContain("The following instructions");
    expect(mcp!.content).not.toContain("After");
  });

  test("merges duplicate routing rule blocks", () => {
    const prompt = `# context-mode \u2014 MANDATORY routing rules\nBlock 1\n# Other\nStuff\n# context-mode \u2014 MANDATORY routing rules\nBlock 2\n# End`;
    const sections = parseSystemPrompt(prompt);
    const routing = sections.filter((s) => s.label === "Routing rules");
    expect(routing).toHaveLength(1);
    expect(routing[0].content).toContain("Block 1");
    expect(routing[0].content).toContain("Block 2");
  });

  test("section bytes sum to total prompt bytes", () => {
    const prompt = `Preamble text\n<file path="/AGENTS.md">\nagent content\n</file>\n<skills>\n<skill name="a">skill a</skill>\n</skills>\n# Memory Guidance\nmemory stuff\n# Next\nTrailing`;
    const sections = parseSystemPrompt(prompt);
    const totalSectionBytes = sections.reduce((sum, s) => sum + s.bytes, 0);
    const promptBytes = new TextEncoder().encode(prompt).length;
    expect(totalSectionBytes).toBe(promptBytes);
  });

  test("handles bare <skill> tags without <skills> wrapper", () => {
    const prompt = `Preamble\n<skill name="a">content a</skill>\n<skill name="b">content b</skill>\nPostamble`;
    const sections = parseSystemPrompt(prompt);
    const skills = sections.find((s) => s.label.startsWith("Skills"));
    expect(skills).toBeDefined();
    expect(skills!.label).toBe("Skills (2)");
  });

  test("does not double-count <file> nested inside <project>", () => {
    const prompt = `<project>\n<file path="/src/types.ts">\ntype Foo = string;\n</file>\n</project>`;
    const sections = parseSystemPrompt(prompt);
    expect(sections.find((s) => s.label === "Project context")).toBeDefined();
    expect(sections.find((s) => s.label === "File: types.ts")).toBeUndefined();
  });
});

describe("buildBreakdown", () => {
  const sampleSections: PromptSection[] = [
    { label: "Base system prompt", bytes: 2048, content: "x".repeat(2048) },
    { label: "AGENTS.md", bytes: 4096, content: "x".repeat(4096) },
    { label: "Skills (2)", bytes: 8192, content: "x".repeat(8192) },
  ];

  test("builds display lines with full data", () => {
    const usage = { tokens: 50000, contextWindow: 200000, percent: 25 };
    const tools = ["read", "edit", "bash"];
    const lines = buildBreakdown(usage, sampleSections, tools);

    expect(lines[0]).toBe("Context Breakdown (~50K / 200K tokens, 25%)");

    const joined = lines.join("\n");
    expect(joined).toContain("AGENTS.md");
    expect(joined).toContain("Skills (2)");
    expect(joined).toContain("Base system prompt");
    expect(joined).toContain("Tools: 3 active");
    expect(joined).toContain("Close");
  });

  test("builds display without usage data", () => {
    const lines = buildBreakdown(null, sampleSections, ["read"]);
    const joined = lines.join("\n");
    expect(joined).toContain("AGENTS.md");
    expect(joined).toContain("Tools: 1 active");
    expect(joined).not.toContain("undefined");
  });

  test("builds display without sections", () => {
    const usage = { tokens: 10000, contextWindow: 200000, percent: 5 };
    const lines = buildBreakdown(usage, [], ["read", "edit"]);
    const joined = lines.join("\n");
    expect(joined).toContain("10K");
    expect(joined).not.toContain("System Prompt");
    expect(joined).toContain("Tools: 2 active");
  });

  test("shows single System Prompt line without sub-breakdown for base-only", () => {
    const usage = { tokens: 5000, contextWindow: 200000, percent: 3 };
    const baseSections: PromptSection[] = [
      { label: "Base system prompt", bytes: 4096, content: "x".repeat(4096) },
    ];
    const lines = buildBreakdown(usage, baseSections, ["read"]);
    const joined = lines.join("\n");
    expect(joined).toContain("System Prompt");
    expect(joined).not.toContain("\u251c");
    expect(joined).not.toContain("\u2514");
    expect(joined).not.toContain("Base system prompt");
  });

  test("handles null token fields in usage", () => {
    const usage = { tokens: null, contextWindow: 200000, percent: null };
    const lines = buildBreakdown(usage as any, sampleSections, []);
    const joined = lines.join("\n");
    expect(joined).toContain("200K");
    expect(joined).not.toContain("null");
  });

  test("shows 'No system prompt captured' when prompt was empty", () => {
    const usage = { tokens: 10000, contextWindow: 200000, percent: 5 };
    const lines = buildBreakdown(usage, [], ["read"], true);
    const joined = lines.join("\n");
    expect(joined).toContain("No system prompt captured");
  });
});