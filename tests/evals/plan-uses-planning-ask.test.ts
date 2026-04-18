// Regression class:
//   "planning-mode prompt drops the planning_ask directive and falls back to generic ask."
//
// How to break it: in src/planning/system-prompt.ts, replace the two
// `planning_ask` references in buildFullPlanningSection / buildPlanningCriticalBlock
// with the generic `ask` tool. This eval will fail on both the positive
// (`planning_ask` present) and negative (no "use the `ask` tool" guidance) checks.

import { defineEval } from "./harness.js";
import { makeEvalPlatform } from "./fixtures.js";
import { registerPlanningAskTool } from "../../src/planning/planning-ask-tool.js";
import { buildPlanningSystemPrompt } from "../../src/planning/system-prompt.js";
import { expect } from "bun:test";

defineEval({
  name: "plan-uses-planning-ask",
  summary: "planning mode prompts the agent to use planning_ask, not the default ask tool",
  regressionClass:
    "planning-mode prompt drops the planning_ask directive and falls back to generic ask",
  run: () => {
    // 1. Tool registration: planning_ask must be registered with description
    //    and promptSnippet that name the tool.
    const { platform, capturedTools } = makeEvalPlatform();
    registerPlanningAskTool(platform);

    const tool = capturedTools["planning_ask"];
    expect(tool).toBeDefined();
    // The registered description points the model at planning sessions and
    // contrasts with the generic ask tool.
    expect(tool.description ?? "").toContain("planning");
    expect(tool.description ?? "").toContain("ask tool");
    expect(tool.promptSnippet ?? "").toContain("planning_ask");

    // 2. Planning system prompt must reference planning_ask.
    const basePrompt = [
      "Base system prompt.",
      "",
      "═══════════Now═══════════",
      "",
      "<critical>",
      "- generic critical block",
      "</critical>",
    ].join("\n");

    const fullPrompt = buildPlanningSystemPrompt(basePrompt, {
      dotDirDisplay: ".omp",
      topic: "test topic",
      isQuick: false,
    });

    // Positive invariant: planning_ask is the recommended question tool.
    expect(fullPrompt).toContain("planning_ask");
    expect(fullPrompt).toContain("`planning_ask` tool");

    // Negative invariant: the prompt must not steer the agent toward the
    // generic `ask` tool for planning-mode user questions. Asserting the
    // exact phrasings the model would interpret as that directive.
    expect(fullPrompt).not.toContain("use the `ask` tool");
    expect(fullPrompt).not.toContain("use `ask`");

    // The critical block must explicitly forbid `ask` for planning prompts.
    // This is the structural guardrail — losing it is the regression.
    expect(fullPrompt).toContain("`planning_ask` tool — never `ask`");
  },
});
