import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  registerPlanningAskTool,
  registerPlanningAskToolGuard,
} from "../../src/planning/planning-ask-tool.js";
import {
  cancelPlanTracking,
  startPlanTracking,
} from "../../src/planning/approval-flow.js";

// ---------------------------------------------------------------------------
// Reset module-level planning state between tests to avoid pollution
// ---------------------------------------------------------------------------
afterEach(() => {
  cancelPlanTracking();
});

function makePlatform() {
  let toolCallHandler: ((event: any) => any) | null = null;
  let toolDef: any = null;
  return {
    on: mock((event: string, handler: any) => {
      if (event === "tool_call") toolCallHandler = handler;
    }),
    registerTool: mock((def: any) => {
      toolDef = def;
    }),
    fireToolCall: async (toolName: string) => {
      if (!toolCallHandler) return undefined;
      return await toolCallHandler({ toolName, input: {} });
    },
    getRegisteredTool: () => toolDef,
  };
}

describe("registerPlanningAskTool — registration", () => {
  test("registers a tool named `planning_ask` with clear description", () => {
    const platform = makePlatform();
    registerPlanningAskTool(platform as any);
    const tool = platform.getRegisteredTool();
    expect(tool).toBeDefined();
    expect(tool.name).toBe("planning_ask");
    expect(tool.description).toContain("planning");
  });
});

describe("registerPlanningAskToolGuard — runtime ask redirect", () => {
  test("no-op when planning is not active", async () => {
    const platform = makePlatform();
    registerPlanningAskToolGuard(platform as any);
    const result = await platform.fireToolCall("ask");
    expect(result).toBeUndefined();
  });

  test("blocks the `ask` tool when planning is active", async () => {
    const platform = makePlatform();
    registerPlanningAskToolGuard(platform as any);

    startPlanTracking("/cwd", { dotDirDisplay: ".omp", project: (_cwd: string, ..._parts: string[]) => "/tmp/does-not-exist" } as any);

    const result = (await platform.fireToolCall("ask")) as
      | { block: true; reason: string }
      | undefined;

    expect(result).toBeDefined();
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("planning_ask");
    expect(result?.reason).toContain("`ask`");
  });

  test("leaves other tool calls alone while planning is active", async () => {
    const platform = makePlatform();
    registerPlanningAskToolGuard(platform as any);

    startPlanTracking("/cwd", { dotDirDisplay: ".omp", project: (_cwd: string, ..._parts: string[]) => "/tmp/does-not-exist" } as any);

    for (const toolName of ["bash", "read", "grep", "planning_ask"]) {
      expect(await platform.fireToolCall(toolName)).toBeUndefined();
    }
  });

  test("stops blocking once planning tracking is cancelled", async () => {
    const platform = makePlatform();
    registerPlanningAskToolGuard(platform as any);

    startPlanTracking("/cwd", { dotDirDisplay: ".omp", project: (_cwd: string, ..._parts: string[]) => "/tmp/does-not-exist" } as any);
    expect((await platform.fireToolCall("ask"))?.block).toBe(true);

    cancelPlanTracking();
    expect(await platform.fireToolCall("ask")).toBeUndefined();
  });
});
