import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { REQUIRED_PENCIL_TOOLS } from "../../src/ui-design/backends/pencil-mcp.js";
import { buildUiDesignSystemPrompt } from "../../src/ui-design/system-prompt.js";

/**
 * Cross-checks that detection (`REQUIRED_PENCIL_TOOLS` consumed by
 * `detectPencilMcp`) stays in lock-step with the prompt the Design Director
 * receives. If a future change adds a tool to `REQUIRED_PENCIL_TOOLS` but
 * forgets to teach the director when to call it, this test fails loudly.
 *
 * It also asserts every `pencil`-shaped token in the pencil sub-agent skill
 * templates uses the canonical `mcp__pencil_<tool>` form, guarding against
 * silent typos like `mcp_pencil_*` or `pencil_*` slipping into prose.
 */

const BASE_PROMPT = [
  "<role>",
  "Base prompt",
  "</role>",
  "",
  "<code-integrity>",
  "stripped",
  "</code-integrity>",
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

const PEN_FILE_PATH = "/abs/path/test.pen";

const PENCIL_TEMPLATE_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "skills",
  "ui-design",
  "sub-agent-templates",
  "pencil",
);

function pencilSubAgentTemplates(): { name: string; content: string }[] {
  return fs
    .readdirSync(PENCIL_TEMPLATE_DIR)
    .filter((entry) => entry.endsWith(".md"))
    .sort()
    .map((entry) => ({
      name: path.basename(entry, ".md"),
      content: fs.readFileSync(path.join(PENCIL_TEMPLATE_DIR, entry), "utf-8"),
    }));
}

describe("REQUIRED_PENCIL_TOOLS consistency", () => {
  test("every required tool appears in the pencil-mcp Director system prompt", () => {
    const prompt = buildUiDesignSystemPrompt(BASE_PROMPT, {
      dotDirDisplay: ".omp",
      sessionDir: "/repo/.omp/supipowers/ui-design/uidesign-xxx",
      companionUrl: "http://localhost:4321",
      backend: "pencil-mcp",
      penFilePath: PEN_FILE_PATH,
      contextScanSummary: "Framework: react · Tokens: tailwind",
      subAgentTemplates: pencilSubAgentTemplates(),
    });

    for (const tool of REQUIRED_PENCIL_TOOLS) {
      expect(prompt).toContain(tool);
    }
  });

  test("REQUIRED_PENCIL_TOOLS list contains only canonical mcp__pencil_<tool> names", () => {
    const canonical = /^mcp__pencil_[a-z_]+$/;
    for (const tool of REQUIRED_PENCIL_TOOLS) {
      expect(tool).toMatch(canonical);
    }
  });

  test("pencil sub-agent skill templates only use the canonical mcp__pencil_<tool> form", () => {
    // Match anything that looks like a pencil tool reference: a token
    // containing `pencil` flanked by word characters / underscores. The test
    // then asserts every such token starts with the canonical prefix.
    const tokenPattern = /[A-Za-z0-9_]*pencil[A-Za-z0-9_]*/g;
    const canonicalPrefix = /^mcp__pencil_/;

    const templateFiles = fs.readdirSync(PENCIL_TEMPLATE_DIR).filter((f) => f.endsWith(".md"));
    expect(templateFiles.length).toBeGreaterThan(0);

    for (const file of templateFiles) {
      const content = fs.readFileSync(path.join(PENCIL_TEMPLATE_DIR, file), "utf8");
      // Strip prose mentions of the bare word "pencil" / "Pencil" / ".pen"
      // so we only inspect tokens that actually look like tool identifiers.
      const matches = (content.match(tokenPattern) ?? []).filter(
        (token) => /[_]/.test(token) || /^mcp/.test(token),
      );
      for (const token of matches) {
        // The bare word "pencil" with no underscores and no `mcp` prefix is
        // prose, not a tool reference. Skip it.
        if (token === "pencil" || token === "Pencil") continue;
        expect(token).toMatch(canonicalPrefix);
      }
    }
  });
});
