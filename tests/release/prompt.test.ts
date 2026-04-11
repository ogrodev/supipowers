import { buildPolishPrompt } from "../../src/release/prompt.js";

describe("buildPolishPrompt", () => {
  const base = {
    changelog: "## 1.2.0\n\n### Features\n- feat: add thing\n\n### Fixes\n- fix: correct bug",
    version: "1.2.0",
  };

  test("includes version in header", () => {
    const prompt = buildPolishPrompt(base);
    expect(prompt).toContain("**v1.2.0**");
  });

  test("embeds raw changelog verbatim", () => {
    const prompt = buildPolishPrompt(base);
    expect(prompt).toContain("feat: add thing");
    expect(prompt).toContain("fix: correct bug");
  });

  test("instructs not to change version numbers", () => {
    const prompt = buildPolishPrompt(base);
    expect(prompt).toMatch(/do \*\*not\*\* change version numbers/i);
  });

  test("instructs to return only polished markdown", () => {
    const prompt = buildPolishPrompt(base);
    expect(prompt).toMatch(/return \*\*only\*\* the polished markdown/i);
  });

  test("empty changelog — shows 'no notable changes' placeholder", () => {
    const prompt = buildPolishPrompt({ ...base, changelog: "" });
    expect(prompt).toContain("No notable changes");
  });

  test("whitespace-only changelog treated as empty", () => {
    const prompt = buildPolishPrompt({ ...base, changelog: "   \n  " });
    expect(prompt).toContain("No notable changes");
  });

  test("returns a string (not null, not undefined)", () => {
    const result = buildPolishPrompt(base);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});
