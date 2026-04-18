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
});
