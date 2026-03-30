import { buildPolishPrompt } from "../../src/release/prompt.js";

describe("buildPolishPrompt", () => {
  const base = {
    changelog: "## 1.2.0\n\n### Features\n- feat: add thing\n\n### Fixes\n- fix: correct bug",
    version: "1.2.0",
    currentVersion: "1.1.0",
    channels: ["github", "npm"] as const,
    commands: ["git tag v1.2.0", "git push --tags", "npm publish"],
  };

  test("includes version transition in header", () => {
    const prompt = buildPolishPrompt(base);
    expect(prompt).toContain("**1.2.0**");
    expect(prompt).toContain("1.1.0");
  });

  test("includes all target channels", () => {
    const prompt = buildPolishPrompt(base);
    expect(prompt).toContain("- github");
    expect(prompt).toContain("- npm");
  });

  test("single channel — only that channel appears in list", () => {
    const prompt = buildPolishPrompt({ ...base, channels: ["github"] });
    expect(prompt).toContain("- github");
    expect(prompt).not.toContain("- npm");
  });

  test("embeds raw changelog verbatim", () => {
    const prompt = buildPolishPrompt(base);
    expect(prompt).toContain("feat: add thing");
    expect(prompt).toContain("fix: correct bug");
  });

  test("includes all commands wrapped in backticks", () => {
    const prompt = buildPolishPrompt(base);
    expect(prompt).toContain("`git tag v1.2.0`");
    expect(prompt).toContain("`git push --tags`");
    expect(prompt).toContain("`npm publish`");
  });

  test("instructs not to change version numbers", () => {
    const prompt = buildPolishPrompt(base);
    expect(prompt).toMatch(/do \*\*not\*\* change version numbers/i);
  });

  test("instructs not to skip commands", () => {
    const prompt = buildPolishPrompt(base);
    expect(prompt).toMatch(/do \*\*not\*\* skip any command/i);
  });

  test("instructs to ask for user confirmation", () => {
    const prompt = buildPolishPrompt(base);
    expect(prompt).toMatch(/yes.*proceed|proceed.*yes/i);
  });

  test("describes abort behavior on rejection", () => {
    const prompt = buildPolishPrompt(base);
    expect(prompt).toMatch(/abort/i);
    expect(prompt).toContain("No changes were made");
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
