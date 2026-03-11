// tests/lsp/detector.test.ts
import { describe, test, expect } from "vitest";
import { isLspAvailable } from "../../src/lsp/detector.js";
import { detectProjectLanguages, getSetupInstructions } from "../../src/lsp/setup-guide.js";
import { buildLspDiagnosticsPrompt } from "../../src/lsp/bridge.js";

describe("isLspAvailable", () => {
  test("returns true when lsp is in active tools", () => {
    expect(isLspAvailable(["read", "write", "lsp", "bash"])).toBe(true);
  });

  test("returns false when lsp is not in active tools", () => {
    expect(isLspAvailable(["read", "write", "bash"])).toBe(false);
  });
});

describe("detectProjectLanguages", () => {
  test("detects typescript from .ts files", () => {
    const langs = detectProjectLanguages(["src/index.ts", "src/types.ts"]);
    expect(langs).toContain("typescript");
  });

  test("detects multiple languages", () => {
    const langs = detectProjectLanguages(["app.py", "main.go", "index.ts"]);
    expect(langs).toContain("python");
    expect(langs).toContain("go");
    expect(langs).toContain("typescript");
  });
});

describe("getSetupInstructions", () => {
  test("returns instructions for detected languages", () => {
    const instructions = getSetupInstructions(["typescript"]);
    expect(instructions.length).toBeGreaterThan(0);
    expect(instructions[0].language).toContain("TypeScript");
  });
});

describe("buildLspDiagnosticsPrompt", () => {
  test("includes all files in prompt", () => {
    const prompt = buildLspDiagnosticsPrompt(["src/a.ts", "src/b.ts"]);
    expect(prompt).toContain("src/a.ts");
    expect(prompt).toContain("src/b.ts");
    expect(prompt).toContain("diagnostics");
  });
});
