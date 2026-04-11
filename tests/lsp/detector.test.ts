// tests/lsp/detector.test.ts

import { isLspAvailable } from "../../src/lsp/detector.js";
import { LSP_SERVERS, formatSetupGuide } from "../../src/lsp/setup-guide.js";
import { buildLspDiagnosticsPrompt } from "../../src/lsp/bridge.js";

describe("isLspAvailable", () => {
  test("returns true when lsp is in active tools", () => {
    expect(isLspAvailable(["read", "write", "lsp", "bash"])).toBe(true);
  });

  test("returns false when lsp is not in active tools", () => {
    expect(isLspAvailable(["read", "write", "bash"])).toBe(false);
  });
});

describe("LSP_SERVERS", () => {
  test("has entries for common languages", () => {
    expect(LSP_SERVERS.length).toBeGreaterThan(0);
    const languages = LSP_SERVERS.map((s) => s.language);
    expect(languages).toContain("TypeScript/JavaScript");
    expect(languages).toContain("Python");
  });
});

describe("formatSetupGuide", () => {
  test("formats all servers", () => {
    const guide = formatSetupGuide();
    expect(guide).toContain("TypeScript/JavaScript");
    expect(guide).toContain("typescript-language-server");
  });

  test("returns message for empty list", () => {
    const guide = formatSetupGuide([]);
    expect(guide).toContain("No LSP servers available");
  });
});

describe("buildLspDiagnosticsPrompt", () => {
  test("includes all files in prompt", () => {
    const prompt = buildLspDiagnosticsPrompt(["src/a.ts", "src/b.ts"], "changed-files");
    expect(prompt).toContain("src/a.ts");
    expect(prompt).toContain("src/b.ts");
    expect(prompt).toContain("diagnostics");
  });
});
