import { describe, expect, test } from "bun:test";
import { isSupiOwnedTool, orderOwnedTools } from "../../src/tool-catalog/tool-groups.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { planActiveTools } from "../../src/tool-catalog/active-tool-planner.js";
import type { ContextModeLazyToolsConfig } from "../../src/types.js";

describe("supipowers-owned tool groups", () => {
  test("identifies only supipowers-owned tool names", () => {
    expect(isSupiOwnedTool("ctx_execute")).toBe(true);
    expect(isSupiOwnedTool("ctx_search")).toBe(true);
    expect(isSupiOwnedTool("ctx_open_cached")).toBe(true);

    expect(isSupiOwnedTool("bash")).toBe(false);
    expect(isSupiOwnedTool("read")).toBe(false);
    expect(isSupiOwnedTool("mcp__server__tool")).toBe(false);
    expect(isSupiOwnedTool("todo_write")).toBe(false);
    expect(isSupiOwnedTool("ultraplan_signal")).toBe(false);
  });

  test("orders owned tools by stable priority and removes duplicates", () => {
    expect(
      orderOwnedTools([
        "ctx_search",
        "ctx_open_cached",
        "ctx_execute",
        "ctx_search",
      ]),
    ).toEqual(["ctx_execute", "ctx_search", "ctx_open_cached"]);
  });
});


const ALL_CTX_TOOLS = [
  "ctx_execute",
  "ctx_execute_file",
  "ctx_batch_execute",
  "ctx_index",
  "ctx_search",
  "ctx_open_cached",
  "ctx_fetch_and_index",
  "ctx_stats",
  "ctx_purge",
] as const;

function lazyTools(overrides: Partial<ContextModeLazyToolsConfig> = {}): ContextModeLazyToolsConfig {
  return {
    ...DEFAULT_CONFIG.contextMode.lazyTools,
    ...overrides,
  };
}

describe("planActiveTools base policy", () => {
  test("preserves non-owned tools exactly while replanning owned tools", () => {
    const plan = planActiveTools({
      prompt: "edit the file",
      currentActive: ["bash", "read", "ctx_batch_execute"],
      allTools: ["bash", "read", ...ALL_CTX_TOOLS],
      lazyTools: lazyTools(),
    });

    expect(plan.activeTools).toEqual(["bash", "read", "ctx_execute", "ctx_search", "ctx_open_cached"]);
    expect(plan.deactivated).toEqual(["ctx_batch_execute"]);
  });

  test("neutral prompts preserve non-owned tools and omit specialized ctx", () => {
    const plan = planActiveTools({
      prompt: "edit the file",
      currentActive: ["bash", "read", "ctx_batch_execute"],
      allTools: ["bash", "read", ...ALL_CTX_TOOLS],
      lazyTools: lazyTools(),
    });

    expect(plan.activeTools).toEqual(["bash", "read", "ctx_execute", "ctx_search", "ctx_open_cached"]);
    expect(plan.activeTools).not.toContain("ctx_batch_execute");
  });

  test("balanced mode keeps only default rescue tools for neutral prompts", () => {
    const plan = planActiveTools({
      prompt: "edit the file",
      currentActive: [],
      allTools: [...ALL_CTX_TOOLS],
      lazyTools: lazyTools({ mode: "balanced" }),
    });

    expect(plan.activeTools).toEqual(["ctx_execute", "ctx_search", "ctx_open_cached"]);
  });

  test("conservative mode keeps registered context tools except rare destructive tools", () => {
    const plan = planActiveTools({
      prompt: "edit the file",
      currentActive: [],
      allTools: [...ALL_CTX_TOOLS],
      lazyTools: lazyTools({ mode: "conservative" }),
    });

    expect(plan.activeTools).toEqual([
      "ctx_execute",
      "ctx_search",
      "ctx_open_cached",
      "ctx_batch_execute",
      "ctx_execute_file",
      "ctx_fetch_and_index",
      "ctx_index",
    ]);
    expect(plan.activeTools).not.toContain("ctx_stats");
    expect(plan.activeTools).not.toContain("ctx_purge");
  });

  test("aggressive mode keeps only configured alwaysKeep tools for neutral prompts", () => {
    const plan = planActiveTools({
      prompt: "edit the file",
      currentActive: [],
      allTools: [...ALL_CTX_TOOLS],
      lazyTools: lazyTools({ mode: "aggressive", alwaysKeep: ["ctx_execute"] }),
    });

    expect(plan.activeTools).toEqual(["ctx_execute"]);
  });

  test("keeps ctx_open_cached active when cache handles are enabled", () => {
    const plan = planActiveTools({
      prompt: "edit the file",
      currentActive: [],
      allTools: [...ALL_CTX_TOOLS],
      lazyTools: lazyTools({ mode: "aggressive", alwaysKeep: ["ctx_execute"] }),
      cacheHandlesEnabled: true,
    });

    expect(plan.activeTools).toEqual(["ctx_execute", "ctx_open_cached"]);
  });

  test("returns deterministic order and deduplicates owned selections", () => {
    const input = {
      prompt: "edit the file",
      currentActive: ["read", "ctx_search"],
      allTools: ["read", ...ALL_CTX_TOOLS],
      lazyTools: lazyTools({ alwaysKeep: ["ctx_execute", "ctx_search", "ctx_execute"] }),
    };

    const first = planActiveTools(input);
    const second = planActiveTools(input);

    expect(first.activeTools).toEqual(second.activeTools);
    expect(first.activeTools.filter((name) => name === "ctx_execute")).toHaveLength(1);
  });
});

describe("planActiveTools prompt triggers", () => {
  test.each([
    ["search the repository", "ctx_batch_execute"],
    ["grep TODOs in src", "ctx_batch_execute"],
    ["read https://example.com/docs", "ctx_fetch_and_index"],
    ["show context stats", "ctx_stats"],
    ["please ctx purge now", "ctx_purge"],
    ["process a large file safely", "ctx_execute_file"],
    [`open cache://${"a".repeat(64)}`, "ctx_open_cached"],
    ["open cached output", "ctx_open_cached"],
    ["inspect this cached handle", "ctx_open_cached"],
    ["use ctx_open_cached please", "ctx_open_cached"],
  ])("activates %s trigger", (prompt, expectedTool) => {
    const plan = planActiveTools({
      prompt,
      currentActive: [],
      allTools: [...ALL_CTX_TOOLS],
      lazyTools: lazyTools(),
    });

    expect(plan.activeTools).toContain(expectedTool);
  });

  test("does not activate purge for vague cleanup language", () => {
    const plan = planActiveTools({
      prompt: "clear some space in the project",
      currentActive: [],
      allTools: [...ALL_CTX_TOOLS],
      lazyTools: lazyTools(),
    });

    expect(plan.activeTools).not.toContain("ctx_purge");
  });

  test("matches keywords case-insensitively with token and phrase rules", () => {
    const todoPlan = planActiveTools({
      prompt: "Find TODO comments",
      currentActive: [],
      allTools: [...ALL_CTX_TOOLS],
      lazyTools: lazyTools(),
    });
    const researchPlan = planActiveTools({
      prompt: "research implementation options",
      currentActive: [],
      allTools: [...ALL_CTX_TOOLS],
      lazyTools: lazyTools(),
    });
    const phrasePlan = planActiveTools({
      prompt: "please analyze     repo structure",
      currentActive: [],
      allTools: [...ALL_CTX_TOOLS],
      lazyTools: lazyTools(),
    });

    expect(todoPlan.activeTools).toContain("ctx_batch_execute");
    expect(researchPlan.activeTools).not.toContain("ctx_batch_execute");
    expect(phrasePlan.activeTools).toContain("ctx_batch_execute");
  });

  test("ignores unknown configured tools", () => {
    const plan = planActiveTools({
      prompt: "please use figma",
      currentActive: [],
      allTools: [...ALL_CTX_TOOLS],
      lazyTools: lazyTools({
        keywordTools: { "fi.*gma": ["fictional_tool"] },
      }),
    });

    expect(plan.activeTools).not.toContain("fictional_tool");
  });

  test("command allowlists add tools without removing defaults", () => {
    const plan = planActiveTools({
      prompt: "/supi:review --deep",
      currentActive: [],
      allTools: [...ALL_CTX_TOOLS],
      lazyTools: lazyTools({
        commandAllowlist: { "supi:review": ["ctx_batch_execute"] },
      }),
    });

    expect(plan.activeTools).toEqual([
      "ctx_execute",
      "ctx_search",
      "ctx_open_cached",
      "ctx_batch_execute",
    ]);
  });
});
