import { describe, test, expect, mock, beforeEach } from "bun:test";
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
    paths: { dotDirDisplay: ".omp" } as any,
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
  mockListPlans.mockClear();
  mockReadPlanFile.mockClear();
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

  test("does nothing when ctx has no UI", async () => {
    mockListPlans.mockReturnValue([]);
    startPlanTracking("/cwd", { dotDirDisplay: ".omp" });

    const platform = makePlatform();
    const ctx = makeCtx({ hasUI: false } as any);
    registerPlanApprovalHook(platform as any);

    await platform.fireAgentEnd(ctx);

    expect(ctx.ui.select).not.toHaveBeenCalled();
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
    expect(prompt).toContain(".omp/supipowers/plans/2026-04-03-myplan.md");
    expect(prompt).toContain("## Tasks");
    expect(prompt).toContain("You **MUST** keep going until complete. This matters.");
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
