import { describe, expect, test } from "bun:test";
import { chunkMarkdown } from "../../../src/context-mode/knowledge/chunker.js";

describe("chunkMarkdown", () => {
  test("single heading + body → one chunk with correct title, body, source", () => {
    const result = chunkMarkdown("# Hello\n\nSome content here.", "test.md");
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Hello");
    expect(result[0].body).toBe("Some content here.");
    expect(result[0].source).toBe("test.md");
  });

  test("multiple headings → one chunk per heading section", () => {
    const input = "# First\n\nBody one.\n\n# Second\n\nBody two.";
    const result = chunkMarkdown(input, "doc");
    expect(result).toHaveLength(2);
    expect(result[0].title).toBe("First");
    expect(result[0].body).toContain("Body one.");
    expect(result[1].title).toBe("Second");
    expect(result[1].body).toContain("Body two.");
  });

  test("nested headings (##, ###) → each gets own chunk", () => {
    const input = "# Top\n\nIntro.\n\n## Sub\n\nDetails.\n\n### Deep\n\nMore details.";
    const result = chunkMarkdown(input, "doc");
    expect(result).toHaveLength(3);
    expect(result[0].title).toBe("Top");
    expect(result[1].title).toBe("Sub");
    expect(result[2].title).toBe("Deep");
  });

  test("heading inside a code block is NOT treated as a section boundary", () => {
    const input = [
      "# Real Heading",
      "",
      "Some text.",
      "",
      "```markdown",
      "# Fake Heading Inside Code",
      "This is code content.",
      "```",
      "",
      "More text after code.",
    ].join("\n");
    const result = chunkMarkdown(input, "s");
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Real Heading");
    expect(result[0].body).toContain("# Fake Heading Inside Code");
    expect(result[0].body).toContain("More text after code.");
  });

  test("content type: body with >50% fenced code → 'code'", () => {
    const input = [
      "# Code Section",
      "",
      "```typescript",
      'const a = 1;',
      'const b = 2;',
      'const c = 3;',
      'const d = 4;',
      'console.log(a + b + c + d);',
      "```",
      "",
      "Brief note.",
    ].join("\n");
    const result = chunkMarkdown(input, "s");
    expect(result).toHaveLength(1);
    expect(result[0].contentType).toBe("code");
  });

  test("content type: body with mostly prose → 'prose'", () => {
    const input = [
      "# Prose Section",
      "",
      "This is a long paragraph about something important. It goes on and on and on.",
      "And another line of prose explaining more details about the topic at hand.",
      "",
      "```",
      "x = 1",
      "```",
    ].join("\n");
    const result = chunkMarkdown(input, "s");
    expect(result).toHaveLength(1);
    expect(result[0].contentType).toBe("prose");
  });

  test("oversized section (>4KB) splits at paragraph boundaries with ' (part N)' suffix", () => {
    // Build a section with multiple paragraphs totaling >4KB
    const para = "A".repeat(1500);
    const input = `# Big\n\n${para}\n\n${para}\n\n${para}\n\n${para}`;
    const result = chunkMarkdown(input, "s");
    expect(result.length).toBeGreaterThan(1);
    expect(result[0].title).toBe("Big (part 1)");
    expect(result[1].title).toBe("Big (part 2)");
    for (const chunk of result) {
      expect(chunk.source).toBe("s");
    }
  });

  test("no headings → single chunk titled with source label", () => {
    const result = chunkMarkdown("Just some text without headings.", "notes.md");
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("notes.md");
    expect(result[0].body).toBe("Just some text without headings.");
  });

  test("empty input → empty array", () => {
    expect(chunkMarkdown("", "s")).toEqual([]);
  });

  test("text before first heading → chunk titled with source", () => {
    const input = "Preamble text.\n\n# First\n\nBody.";
    const result = chunkMarkdown(input, "readme.md");
    expect(result).toHaveLength(2);
    expect(result[0].title).toBe("readme.md");
    expect(result[0].body).toBe("Preamble text.");
    expect(result[1].title).toBe("First");
  });

  test("empty heading (heading line with no content below) is dropped", () => {
    const input = "# Has Content\n\nSome body.\n\n# Empty\n\n# Also Content\n\nMore body.";
    const result = chunkMarkdown(input, "s");
    expect(result).toHaveLength(2);
    expect(result[0].title).toBe("Has Content");
    expect(result[1].title).toBe("Also Content");
  });

  test("source string passed through to all chunks", () => {
    const input = "# A\n\nBody A.\n\n# B\n\nBody B.";
    const result = chunkMarkdown(input, "my-source");
    for (const chunk of result) {
      expect(chunk.source).toBe("my-source");
    }
  });

  test("code fence with language hint is handled", () => {
    const input = [
      "# Example",
      "",
      "```python",
      "# This heading-like line inside code",
      "print('hello')",
      "```",
    ].join("\n");
    const result = chunkMarkdown(input, "s");
    expect(result).toHaveLength(1);
    expect(result[0].body).toContain("print('hello')");
  });

  test("multiple consecutive empty lines do not create empty chunks", () => {
    const input = "# Title\n\n\n\n\nSome content.";
    const result = chunkMarkdown(input, "s");
    expect(result).toHaveLength(1);
    expect(result[0].body).toBe("Some content.");
  });

  test("oversized section does not split mid-code-block", () => {
    // Build a section where a code block straddles what would be a paragraph boundary
    const proseBefore = "X".repeat(2000);
    const codeBlock = "```\n" + "Y".repeat(1000) + "\n\n" + "Z".repeat(1000) + "\n```";
    const proseAfter = "W".repeat(500);
    const input = `# Big\n\n${proseBefore}\n\n${codeBlock}\n\n${proseAfter}`;
    const result = chunkMarkdown(input, "s");
    // The code block should appear intact in one chunk
    const codeChunk = result.find((c) => c.body.includes("```"));
    expect(codeChunk).toBeDefined();
    expect(codeChunk!.body).toContain("Y".repeat(1000));
    expect(codeChunk!.body).toContain("Z".repeat(1000));
  });
});
