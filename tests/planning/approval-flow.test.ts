import * as fs from "node:fs";
import * as path from "node:path";

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

import { createPaths } from "../../src/platform/types.js";
import { getProjectStatePath } from "../../src/workspace/state-paths.js";
import {
  startPlanTracking,
  cancelPlanTracking,
  isPlanningActive,
  registerPlanApprovalHook,
} from "../../src/planning/approval-flow.js";

// ---------------------------------------------------------------------------
// Minimal mocks
// ---------------------------------------------------------------------------

mock.module("../../src/storage/plans.js", () => ({
  listPlans: mock(),
  readPlanFile: mock(),
}));

import { listPlans, readPlanFile } from "../../src/storage/plans.js";

const mockListPlans = listPlans as unknown as ReturnType<typeof mock>;
const mockReadPlanFile = readPlanFile as unknown as ReturnType<typeof mock>;

function realListPlans(paths: any, cwd: string): string[] {
  const dir = getProjectStatePath(paths, cwd, "plans");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .reverse();
}

function realReadPlanFile(paths: any, cwd: string, name: string): string | null {
  const filePath = path.join(getProjectStatePath(paths, cwd, "plans"), name);
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : null;
}

function resetPlanStorageMocks(): void {
  mockListPlans.mockReset();
  mockReadPlanFile.mockReset();
  mockListPlans.mockImplementation(realListPlans);
  mockReadPlanFile.mockImplementation(realReadPlanFile);
}

type MockPlatform = {
  paths: any;
  on: ReturnType<typeof mock>;
  sendMessage: ReturnType<typeof mock>;
  sendUserMessage: ReturnType<typeof mock>;
  fireAgentEnd: (ctx: any) => Promise<void>;
};

type MockCtx = {
  hasUI: boolean;
  ui: {
    select: ReturnType<typeof mock>;
    input: ReturnType<typeof mock>;
    setEditorText: ReturnType<typeof mock>;
    notify: ReturnType<typeof mock>;
  };
  newSession: ReturnType<typeof mock>;
  sendUserMessage: ReturnType<typeof mock>;
};

function makePlatform(overrides: Partial<MockPlatform> = {}): MockPlatform {
  let hookedHandler: ((event: any, ctx: any) => Promise<void>) | null = null;
  const platform: MockPlatform = {
    paths: createPaths(".omp"),
    on: mock((event: string, handler: any) => {
      if (event === "agent_end") hookedHandler = handler;
    }),
    sendMessage: mock(),
    sendUserMessage: mock(),
    // Helper to fire the hook manually in tests
    fireAgentEnd: async (ctx: any) => {
      if (hookedHandler) await hookedHandler({}, ctx);
    },
    ...overrides,
  };
  return platform;
}

function makeCtx(overrides: Partial<MockCtx> = {}): MockCtx {
  return {
    hasUI: true,
    ui: {
      select: mock(),
      input: mock(),
      setEditorText: mock(),
      notify: mock(),
    },
    newSession: mock().mockResolvedValue({}),
    sendUserMessage: mock(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  cancelPlanTracking();
  resetPlanStorageMocks();
});

afterEach(() => {
  cancelPlanTracking();
  resetPlanStorageMocks();
});

// ---------------------------------------------------------------------------
// startPlanTracking / isPlanningActive / cancelPlanTracking
// ---------------------------------------------------------------------------

describe("plan tracking state", () => {
  test("inactive by default", () => {
    expect(isPlanningActive()).toBe(false);
  });

  test("active after startPlanTracking", () => {
    mockListPlans.mockReturnValue([]);
    startPlanTracking("/cwd", { dotDirDisplay: ".omp" });
    expect(isPlanningActive()).toBe(true);
  });

  test("inactive after cancelPlanTracking", () => {
    mockListPlans.mockReturnValue([]);
    startPlanTracking("/cwd", { dotDirDisplay: ".omp" });
    cancelPlanTracking();
    expect(isPlanningActive()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// No-op when no UI or not active
// ---------------------------------------------------------------------------

describe("agent_end hook guards", () => {
  test("does nothing when planning is not active", async () => {
    const platform = makePlatform();
    const ctx = makeCtx();
    registerPlanApprovalHook(platform as any);

    await platform.fireAgentEnd(ctx);

    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  test("does not show approval UI when ctx has no UI and no new plans exist", async () => {
    mockListPlans.mockReturnValue([]);
    startPlanTracking("/cwd", { dotDirDisplay: ".omp" });

    const platform = makePlatform();
    const ctx = makeCtx({ hasUI: false } as any);
    registerPlanApprovalHook(platform as any);

    await platform.fireAgentEnd(ctx);

    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(platform.sendMessage).not.toHaveBeenCalled();
  });

  test("no UI shown and snapshot updated when no new plans detected", async () => {
    mockListPlans.mockReturnValue(["existing-plan.md"]);
    startPlanTracking("/cwd", { dotDirDisplay: ".omp" });

    // After startPlanTracking, plansBefore = ["existing-plan.md"]
    // On agent_end with same list → no new plans
    mockListPlans.mockReturnValue(["existing-plan.md"]);

    const platform = makePlatform();
    const ctx = makeCtx();
    registerPlanApprovalHook(platform as any);

    await platform.fireAgentEnd(ctx);

    expect(ctx.ui.select).not.toHaveBeenCalled();
  });
});

  test("valid plan in no-UI mode is surfaced without execution", async () => {
    mockListPlans
      .mockReturnValueOnce([])
      .mockReturnValue(["plan.md"]);
    mockReadPlanFile.mockReturnValue("content");

    const ctx = makeCtx({ hasUI: false } as any);
    startPlanTracking("/cwd", { dotDirDisplay: ".omp" }, ctx.newSession as any);

    const platform = makePlatform();
    registerPlanApprovalHook(platform as any);

    await platform.fireAgentEnd(ctx);

    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(ctx.newSession).not.toHaveBeenCalled();
    expect(platform.sendUserMessage).not.toHaveBeenCalled();
    expect(platform.sendMessage).toHaveBeenCalledTimes(1);
    const [msg, opts] = platform.sendMessage.mock.calls[0];
    expect(msg.customType).toBe("supi-plan-awaiting-interactive-approval");
    expect(msg.display).toBe(true);
    expect(msg.content[0].text).toContain("Interactive approval is unavailable");
    expect(msg.content[0].text).toContain("Execute the saved plan");
    expect(opts).toEqual({ deliverAs: "steer", triggerTurn: false });
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Plan saved; interactive approval is required before execution.",
      "warning",
    );
    expect(isPlanningActive()).toBe(false);
  });

// ---------------------------------------------------------------------------
// "Approve and execute" — happy path (newSession available)
// ---------------------------------------------------------------------------

describe("Approve and execute", () => {
  test("calls newSession then sendUserMessage with execution prompt", async () => {
    mockListPlans
      .mockReturnValueOnce([]) // startPlanTracking
      .mockReturnValue(["2026-04-03-myplan.md"]); // agent_end
    mockReadPlanFile.mockReturnValue("## Tasks\n- step 1");

    const ctx = makeCtx();
    startPlanTracking("/cwd", { dotDirDisplay: ".omp" }, ctx.newSession as any);

    const platform = makePlatform();
    ctx.ui.select.mockResolvedValue("Approve and execute");
    registerPlanApprovalHook(platform as any);

    await platform.fireAgentEnd(ctx);

    expect(ctx.newSession).toHaveBeenCalledTimes(1);
    expect(platform.sendUserMessage).toHaveBeenCalledTimes(1);

    const prompt: string = platform.sendUserMessage.mock.calls[0][0];
    expect(prompt).toContain("Plan approved. You **MUST** execute it now.");
    const expectedPlanPath = path.join(
      getProjectStatePath(platform.paths, "/cwd", "plans"),
      "2026-04-03-myplan.md",
    );
    expect(prompt).toContain(expectedPlanPath);
    expect(prompt).toContain("## Tasks");
    expect(prompt).toContain("You **MUST** keep going until complete. This matters.");
  });

  test("embeds todo_write init payload when plan has tasks", async () => {
    mockListPlans
      .mockReturnValueOnce([])
      .mockReturnValue(["plan-with-tasks.md"]);
    mockReadPlanFile.mockReturnValue([
      "---",
      "name: plan-with-tasks",
      "created: 2026-04-26",
      "tags: []",
      "---",
      "",
      "## Context",
      "Some context.",
      "",
      "## Tasks",
      "",
      "### 1. Add new types [parallel-safe]",
      "- **files**: src/types.ts",
      "- **criteria**: Types compile",
      "- **complexity**: small",
      "",
      "### 2. Wire detector [sequential: depends on 1]",
      "- **files**: src/detector.ts",
      "- **criteria**: Detector works",
      "- **complexity**: medium",
      "",
    ].join("\n"));

    const ctx = makeCtx();
    startPlanTracking("/cwd", { dotDirDisplay: ".omp" }, ctx.newSession as any);

    const platform = makePlatform();
    ctx.ui.select.mockResolvedValue("Approve and execute");
    registerPlanApprovalHook(platform as any);

    await platform.fireAgentEnd(ctx);

    const prompt: string = platform.sendUserMessage.mock.calls[0][0];
    expect(prompt).toContain("todo_write");
    expect(prompt).toContain('"op": "init"');
    expect(prompt).toContain('"phase": "Implementation"');
    expect(prompt).toContain('"items"');
    expect(prompt).toContain('"task": "Add new types"');
    expect(prompt).toContain('"text": "Types compile"');
    expect(prompt).toContain("## Initialize todo tracker");
    expect(prompt).not.toContain('"op": "replace"');
    expect(prompt).not.toContain("I. Implementation");
    expect(prompt).not.toContain("task-1");
  });

  test("omits todo block when plan parses to zero tasks", async () => {
    mockListPlans
      .mockReturnValueOnce([])
      .mockReturnValue(["empty-plan.md"]);
    // Parse-able plan with valid frontmatter but no `### N.` task headers.
    mockReadPlanFile.mockReturnValue([
      "---",
      "name: empty-plan",
      "created: 2026-04-26",
      "tags: []",
      "---",
      "",
      "## Context",
      "No tasks.",
      "",
    ].join("\n"));

    const ctx = makeCtx();
    startPlanTracking("/cwd", { dotDirDisplay: ".omp" }, ctx.newSession as any);

    const platform = makePlatform();
    ctx.ui.select.mockResolvedValue("Approve and execute");
    registerPlanApprovalHook(platform as any);

    await platform.fireAgentEnd(ctx);

    expect(platform.sendUserMessage).toHaveBeenCalledTimes(1);
    const prompt: string = platform.sendUserMessage.mock.calls[0][0];
    expect(prompt).not.toContain("## Initialize todo tracker");
    expect(prompt).not.toContain("todo_write");
  });

  test("planning is deactivated after approve", async () => {
    mockListPlans
      .mockReturnValueOnce([])
      .mockReturnValue(["plan.md"]);
    mockReadPlanFile.mockReturnValue("content");

    const ctx = makeCtx();
    startPlanTracking("/cwd", { dotDirDisplay: ".omp" }, ctx.newSession as any);

    const platform = makePlatform();
    ctx.ui.select.mockResolvedValue("Approve and execute");
    registerPlanApprovalHook(platform as any);

    await platform.fireAgentEnd(ctx);

    expect(isPlanningActive()).toBe(false);
  });

  test("cancelled newSession: notifies and does NOT send message", async () => {
    mockListPlans
      .mockReturnValueOnce([])
      .mockReturnValue(["plan.md"]);
    mockReadPlanFile.mockReturnValue("content");

    const ctx = makeCtx();
    ctx.newSession.mockResolvedValue({ cancelled: true });
    startPlanTracking("/cwd", { dotDirDisplay: ".omp" }, ctx.newSession as any);

    const platform = makePlatform();
    ctx.ui.select.mockResolvedValue("Approve and execute");
    registerPlanApprovalHook(platform as any);

    await platform.fireAgentEnd(ctx);

    expect(ctx.sendUserMessage).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("cancelled"),
    );
  });

  test("falls back to same-session steer when newSession is unavailable", async () => {
    mockListPlans
      .mockReturnValueOnce([])
      .mockReturnValue(["plan.md"]);
    mockReadPlanFile.mockReturnValue("content");

    startPlanTracking("/cwd", { dotDirDisplay: ".omp" });

    const platform = makePlatform();
    // ctx without newSession (SDK/headless)
    const ctx = {
      hasUI: true,
      ui: { select: mock(), input: mock(), setEditorText: mock(), notify: mock() },
      sendUserMessage: mock(),
      // newSession intentionally absent
    };
    ctx.ui.select.mockResolvedValue("Approve and execute");
    registerPlanApprovalHook(platform as any);

    await platform.fireAgentEnd(ctx);

    expect(platform.sendMessage).toHaveBeenCalledTimes(1);
    const [msg] = platform.sendMessage.mock.calls[0];
    expect(msg.customType).toBe("supi-plan-execute");
    expect(ctx.sendUserMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// "Refine plan"
// ---------------------------------------------------------------------------

describe("Refine plan", () => {
  test("with content: setEditorText called, planning stays active", async () => {
    mockListPlans
      .mockReturnValueOnce([])
      .mockReturnValue(["plan.md"]);
    mockReadPlanFile.mockReturnValue("content");

    startPlanTracking("/cwd", { dotDirDisplay: ".omp" });

    const platform = makePlatform();
    const ctx = makeCtx();
    ctx.ui.select.mockResolvedValue("Refine plan");
    ctx.ui.input.mockResolvedValue("please add error handling");
    registerPlanApprovalHook(platform as any);

    await platform.fireAgentEnd(ctx);

    expect(ctx.ui.setEditorText).toHaveBeenCalledWith("please add error handling");
    expect(ctx.newSession).not.toHaveBeenCalled();
    expect(isPlanningActive()).toBe(true);
  });

  test("empty input (misclick): falls through to approve flow", async () => {
    mockListPlans
      .mockReturnValueOnce([])
      .mockReturnValue(["plan.md"]);
    mockReadPlanFile.mockReturnValue("content");

    const ctx = makeCtx();
    startPlanTracking("/cwd", { dotDirDisplay: ".omp" }, ctx.newSession as any);

    const platform = makePlatform();
    ctx.ui.select.mockResolvedValue("Refine plan");
    ctx.ui.input.mockResolvedValue(""); // empty = misclick
    registerPlanApprovalHook(platform as any);

    await platform.fireAgentEnd(ctx);

    expect(ctx.newSession).toHaveBeenCalledTimes(1);
    expect(platform.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(isPlanningActive()).toBe(false);
  });

  test("whitespace-only input (misclick): falls through to approve flow", async () => {
    mockListPlans
      .mockReturnValueOnce([])
      .mockReturnValue(["plan.md"]);
    mockReadPlanFile.mockReturnValue("content");

    const ctx = makeCtx();
    startPlanTracking("/cwd", { dotDirDisplay: ".omp" }, ctx.newSession as any);

    const platform = makePlatform();
    ctx.ui.select.mockResolvedValue("Refine plan");
    ctx.ui.input.mockResolvedValue("   "); // whitespace = misclick
    registerPlanApprovalHook(platform as any);

    await platform.fireAgentEnd(ctx);

    expect(ctx.newSession).toHaveBeenCalledTimes(1);
    expect(platform.sendUserMessage).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// "Stay in plan mode"
// ---------------------------------------------------------------------------

describe("Stay in plan mode", () => {
  test("cancels tracking and notifies", async () => {
    mockListPlans
      .mockReturnValueOnce([])
      .mockReturnValue(["plan.md"]);
    mockReadPlanFile.mockReturnValue("content");

    startPlanTracking("/cwd", { dotDirDisplay: ".omp" });

    const platform = makePlatform();
    const ctx = makeCtx();
    ctx.ui.select.mockResolvedValue("Stay in plan mode");
    registerPlanApprovalHook(platform as any);

    await platform.fireAgentEnd(ctx);

    expect(isPlanningActive()).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Planning complete. Plan saved but not executing.",
    );
    expect(ctx.newSession).not.toHaveBeenCalled();
    expect(ctx.sendUserMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Selector labels match OMP exactly
// ---------------------------------------------------------------------------

describe("selector labels", () => {
  test("selector presents exactly the three expected options", async () => {
    mockListPlans
      .mockReturnValueOnce([])
      .mockReturnValue(["plan.md"]);
    mockReadPlanFile.mockReturnValue("content");

    startPlanTracking("/cwd", { dotDirDisplay: ".omp" });

    const platform = makePlatform();
    const ctx = makeCtx();
    ctx.ui.select.mockResolvedValue("Stay in plan mode");
    registerPlanApprovalHook(platform as any);

    await platform.fireAgentEnd(ctx);

    const [, options] = ctx.ui.select.mock.calls[0];
    expect(options).toEqual([
      "Approve and execute",
      "Refine plan",
      "Stay in plan mode",
    ]);
  });
});

// ---------------------------------------------------------------------------
// PlanSpec validation gate (P3-03)
// ---------------------------------------------------------------------------

describe("PlanSpec validation gate", () => {
  test("invalid plan triggers a retry steer and suppresses approval UI", async () => {
    // Plan file has no frontmatter AND an empty filename — parsePlan returns
    // name: "" which violates PlanSpecSchema's `name: minLength 1`.
    mockListPlans
      .mockReturnValueOnce([]) // startPlanTracking
      .mockReturnValue([".md"]);
    mockReadPlanFile.mockReturnValue("no frontmatter, no tasks");

    const ctx = makeCtx();
    startPlanTracking("/cwd", { dotDirDisplay: ".omp" }, ctx.newSession as any);

    const platform = makePlatform();
    registerPlanApprovalHook(platform as any);

    await platform.fireAgentEnd(ctx);

    // Approval UI must NOT be shown.
    expect(ctx.ui.select).not.toHaveBeenCalled();
    // A retry steer must be sent so the agent can fix the plan.
    expect(platform.sendMessage).toHaveBeenCalledTimes(1);
    const [msg, opts] = platform.sendMessage.mock.calls[0];
    expect(msg.customType).toBe("supi-plan-invalid");
    expect(opts).toEqual({ deliverAs: "steer", triggerTurn: true });
  });
});
