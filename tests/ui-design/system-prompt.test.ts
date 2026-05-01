import { describe, expect, mock, test } from "bun:test";
import {
  buildUiDesignSystemPrompt,
  registerUiDesignSystemPromptHook,
} from "../../src/ui-design/system-prompt.js";
import {
  cancelUiDesignTracking,
  startUiDesignTracking,
} from "../../src/ui-design/session.js";
import type { UiDesignSession } from "../../src/ui-design/types.js";

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

const BASE_OPTIONS = {
  dotDirDisplay: ".omp",
  sessionDir: "/repo/.omp/supipowers/ui-design/uidesign-xxx",
  companionUrl: "http://localhost:4321",
  backend: "local-html" as const,
  contextScanSummary: "Framework: react · Tokens: tailwind · Components: 3 · design.md: present",
};

function session(): UiDesignSession {
  return {
    id: "uidesign-xxx",
    dir: "/repo/.omp/supipowers/ui-design/uidesign-xxx",
    backend: "local-html",
    companionUrl: "http://localhost:4321",
  };
}

describe("ui-design system prompt", () => {
  test("injects Design Director block", () => {
    const prompt = buildUiDesignSystemPrompt(BASE_PROMPT, BASE_OPTIONS);
    expect(prompt).toContain("═══Design Director═══");
  });

  test("includes HARD-GATE", () => {
    const prompt = buildUiDesignSystemPrompt(BASE_PROMPT, BASE_OPTIONS);
    expect(prompt).toContain("HARD-GATE");
    expect(prompt).toContain("`planning_ask`");
  });

  test("scopes edit tools to session artifacts", () => {
    const prompt = buildUiDesignSystemPrompt(BASE_PROMPT, BASE_OPTIONS);
    expect(prompt).toContain("implement production code or write outside the session directory");
    expect(prompt).toContain("edit tools, including `apply_patch`, are allowed only for artifacts");
  });

  test("preserves the base Rules block", () => {
    const prompt = buildUiDesignSystemPrompt(BASE_PROMPT, BASE_OPTIONS);
    expect(prompt).toContain("base rules");
    expect(prompt).toContain("═══════════Rules═══════════");
  });

  test("lists all 9 model-owned phases in order", () => {
    const prompt = buildUiDesignSystemPrompt(BASE_PROMPT, BASE_OPTIONS);
    const phases = [
      "Phase 1",
      "Phase 2",
      "Phase 3",
      "Phase 4",
      "Phase 5",
      "Phase 6",
      "Phase 7",
      "Phase 8",
      "Phase 9",
    ];
    let cursor = 0;
    for (const phase of phases) {
      const idx = prompt.indexOf(phase, cursor);
      expect(idx).toBeGreaterThan(-1);
      cursor = idx + phase.length;
    }
  });

  test("injects topic when provided", () => {
    const prompt = buildUiDesignSystemPrompt(BASE_PROMPT, { ...BASE_OPTIONS, topic: "landing page" });
    expect(prompt).toContain("landing page");
  });

  test("renders ContextScan summary", () => {
    const prompt = buildUiDesignSystemPrompt(BASE_PROMPT, BASE_OPTIONS);
    expect(prompt).toContain("Framework: react");
    expect(prompt).toContain("Tokens: tailwind");
  });

  test("strips stake/code-integrity tags", () => {
    const prompt = buildUiDesignSystemPrompt(BASE_PROMPT, BASE_OPTIONS);
    expect(prompt).not.toContain("<code-integrity>");
  });

  test("preserves tools section", () => {
    const prompt = buildUiDesignSystemPrompt(BASE_PROMPT, BASE_OPTIONS);
    expect(prompt).toContain("# Tools");
  });

  test("appends skillContent when provided", () => {
    const prompt = buildUiDesignSystemPrompt(BASE_PROMPT, {
      ...BASE_OPTIONS,
      skillContent: "Extra director note.",
    });
    expect(prompt).toContain("Extra director note.");
  });

  test("hook only fires when ui-design is active", () => {
    let handler: ((event: any, ctx: any) => any) | null = null;
    const platform: any = {
      on: mock((name: string, cb: any) => {
        if (name === "before_agent_start") handler = cb;
      }),
      paths: { dotDirDisplay: ".omp", project: () => "", global: () => "", agent: () => "", dotDir: ".omp" },
    };
    registerUiDesignSystemPromptHook(platform);

    cancelUiDesignTracking("test-reset");
    const result1 = handler!({ systemPrompt: "base" }, { cwd: "/repo", hasUI: true });
    expect(result1).toBeUndefined();

    // activate
    const s = session();
    startUiDesignTracking(s, async () => {});
    const result2 = handler!({ systemPrompt: BASE_PROMPT }, { cwd: "/repo", hasUI: true });
    expect(result2?.systemPrompt).toContain("═══Design Director═══");
    cancelUiDesignTracking("test-teardown");
  });

  test("pencil-mcp backend emits the pencil phase table + HARD-GATE penFilePath rule", () => {
    const prompt = buildUiDesignSystemPrompt(BASE_PROMPT, {
      ...BASE_OPTIONS,
      backend: "pencil-mcp" as const,
      penFilePath: "/Users/me/proj/designs/home.pen",
    });
    expect(prompt).toContain("mcp__pencil_open_document");
    expect(prompt).toContain("mcp__pencil_batch_design");
    expect(prompt).toContain("node-manifest.json");
    expect(prompt).toContain("screen-review.png");
    // The pencil table replaces the HTML table — page.html MUST NOT leak through.
    expect(prompt).not.toContain("<session>/page.html");
    // HARD-GATE cites the exact .pen path
    expect(prompt).toContain("filePath: '/Users/me/proj/designs/home.pen'");
    expect(prompt).toContain("filePathOrTemplate: '/Users/me/proj/designs/home.pen'");
  });

  test("local-html backend keeps the HTML phase table and does not leak pencil rules", () => {
    const prompt = buildUiDesignSystemPrompt(BASE_PROMPT, BASE_OPTIONS);
    expect(prompt).toContain("<session>/page.html");
    expect(prompt).not.toContain("mcp__pencil_open_document");
    expect(prompt).not.toContain("screen-review.png");
  });

  test("pencil-mcp header lists the .pen file path", () => {
    const prompt = buildUiDesignSystemPrompt(BASE_PROMPT, {
      ...BASE_OPTIONS,
      backend: "pencil-mcp" as const,
      penFilePath: "/abs/design.pen",
    });
    expect(prompt).toContain(".pen file: /abs/design.pen");
  });

  test("pencil Phase 8 references mcp__pencil_batch_design with filePath pinning", () => {
    const prompt = buildUiDesignSystemPrompt(BASE_PROMPT, {
      ...BASE_OPTIONS,
      backend: "pencil-mcp" as const,
      penFilePath: "/abs/design.pen",
    });
    // Phase 8 row must name the actual tool, not the bare `batch_design` alias.
    expect(prompt).toMatch(/Phase 8.*mcp__pencil_batch_design/);
    expect(prompt).toMatch(/Phase 8.*filePath/);
  });

  test("pencil backend without penFilePath keeps the pencil prompt self-consistent", () => {
    const prompt = buildUiDesignSystemPrompt(BASE_PROMPT, {
      ...BASE_OPTIONS,
      backend: "pencil-mcp" as const,
      // penFilePath deliberately omitted — e.g. fallback from a resumed session
    });
    // Must still use the pencil phase table — not the HTML one.
    expect(prompt).toContain("mcp__pencil_batch_design");
    expect(prompt).toContain("mcp__pencil_open_document");
    expect(prompt).not.toContain("<session>/page.html");
    // HARD-GATE must direct the director to recover the path from manifest.json.
    expect(prompt).toContain("recorded in `manifest.json` under `penFilePath`");
    expect(prompt).toContain("filePathOrTemplate");
  });

});
