import { afterEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  registerPlanningAskTool,
  registerPlanningAskToolGuard,
} from "../../src/planning/planning-ask-tool.js";
import {
  cancelPlanTracking,
  startPlanTracking,
} from "../../src/planning/approval-flow.js";
import {
  cancelUiDesignTracking,
  startUiDesignTracking,
} from "../../src/ui-design/session.js";

// ---------------------------------------------------------------------------
// Reset module-level planning/ui-design state between tests to avoid pollution
// ---------------------------------------------------------------------------
afterEach(() => {
  cancelPlanTracking();
  cancelUiDesignTracking("test-cleanup");
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

describe("registerPlanningAskTool — execution", () => {
  test("records the ui-design review approval artifact for phase-9 decisions", async () => {
    const platform = makePlatform();
    registerPlanningAskTool(platform as any);
    const tool = platform.getRegisteredTool();
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-ui-design-approval-"));

    try {
      fs.writeFileSync(
        path.join(sessionDir, "screen-review.html"),
        "<!DOCTYPE html><html><body><section>review</section></body></html>",
      );
      startUiDesignTracking(
        {
          id: "uidesign-20260418-120000-abcd",
          dir: sessionDir,
          backend: "local-html",
          companionUrl: "http://localhost:4321",
        },
        async () => {},
      );

      const result = await tool.execute(
        "call-1",
        {
          question: "Approve the mockup?",
          options: [
            { label: "approve" },
            { label: "request-changes" },
            { label: "discard" },
          ],
        },
        new AbortController().signal,
        null,
        { ui: { select: mock(async () => "approve") } },
      );

      const record = JSON.parse(
        fs.readFileSync(path.join(sessionDir, "review-approval.json"), "utf-8"),
      );
      expect(record.selected).toBe("approve");
      expect(record.selectedLabel).toBe("approve");
      expect(result.details).toEqual({ question: "Approve the mockup?", selected: "approve" });
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});

describe("registerPlanningAskToolGuard — runtime ask redirect", () => {
  test("no-op when neither planning nor ui-design is active", async () => {
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

  test("blocks the `ask` tool when ui-design is active", async () => {
    const platform = makePlatform();
    registerPlanningAskToolGuard(platform as any);

    startUiDesignTracking(
      {
        id: "uidesign-20260418-120000-abcd",
        dir: "/tmp/ui-design-session",
        backend: "local-html",
        companionUrl: "http://localhost:4321",
      },
      async () => {},
    );

    const result = (await platform.fireToolCall("ask")) as
      | { block: true; reason: string }
      | undefined;

    expect(result).toBeDefined();
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("UI-design mode");
    expect(result?.reason).toContain("planning_ask");
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
