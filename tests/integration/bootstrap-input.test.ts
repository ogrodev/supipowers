import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createPaths } from "../../src/platform/types.js";
import { cancelUiDesignTracking, isUiDesignActive, startUiDesignTracking } from "../../src/ui-design/session.js";


function createPlatform(options: { withRegisterTool?: boolean } = {}) {
  const handlers = new Map<string, any>();
  const handlersByEvent = new Map<string, any[]>();
  const registerTool = options.withRegisterTool ? mock() : undefined;
  const platform = {
    name: "omp",
    registerCommand: mock(),
    getCommands: mock(() => []),
    getActiveTools: mock(() => ["bash", "ctx_execute"]),
    getAllTools: mock(() => [
      "bash",
      "ctx_execute",
      "ctx_search",
      "ctx_batch_execute",
      "mcpc_manager",
      "mcpc_figma",
    ]),
    setActiveTools: mock(async () => {}),
    exec: mock(async () => ({ stdout: "", stderr: "", code: 0 })),
    sendMessage: mock(),
    sendUserMessage: mock(),
    registerMessageRenderer: mock(),
    createAgentSession: mock(),
    on: mock((name: string, cb: any) => {
      handlers.set(name, cb);
      const list = handlersByEvent.get(name) ?? [];
      list.push(cb);
      handlersByEvent.set(name, list);
    }),
    registerTool,
    paths: createPaths(".omp"),
    capabilities: {
      agentSessions: true,
      compactionHooks: false,
      customWidgets: true,
      registerTool: Boolean(registerTool),
      activeToolFiltering: true,
    },
  } as any;
  return { platform, handlers, handlersByEvent };
}

describe("bootstrap input interception", () => {
  beforeEach(() => {
    cancelUiDesignTracking("bootstrap-test-reset");
  });

  test("intercepts /supi:review input before chat submission", async () => {
    const bootstrapModulePath = "../../src/bootstrap.js?bootstrap-input-review";
    const { bootstrap } = await import(bootstrapModulePath);
    const { platform, handlers } = createPlatform();

    bootstrap(platform);

    const inputHandler = handlers.get("input");
    expect(inputHandler).toBeDefined();

    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      ui: {
        notify: mock(),
        select: mock(async () => null),
        custom: mock(async () => null),
        input: mock(async () => null),
      },
      modelRegistry: { getAvailable: () => [] },
    } as any;

    const result = inputHandler({ text: "/supi:review --target pkg-a" }, ctx);

    expect(result).toEqual({ action: "handled" });
  });

  test("session_shutdown tears down any active ui-design companion", async () => {
    const bootstrapModulePath = "../../src/bootstrap.js?bootstrap-input-shutdown";
    const { bootstrap } = await import(bootstrapModulePath);
    const { platform, handlers } = createPlatform();
    const cleanup = mock(async () => {});

    startUiDesignTracking(
      {
        id: "uidesign-20260418-120000-abcd",
        dir: "/tmp/ui-design-session",
        backend: "local-html",
        companionUrl: "http://localhost:4321",
      },
      cleanup,
    );
    expect(isUiDesignActive()).toBe(true);

    bootstrap(platform);

    const shutdownHandler = handlers.get("session_shutdown");
    expect(shutdownHandler).toBeDefined();

    await shutdownHandler({}, { cwd: process.cwd(), hasUI: true, ui: { notify: mock() } });

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(isUiDesignActive()).toBe(false);
  });

  test("registers UltraPlan tools when tool registration is available", async () => {
    const bootstrapModulePath = "../../src/bootstrap.js?bootstrap-input-ultraplan-tools";
    const { bootstrap } = await import(bootstrapModulePath);
    const { platform } = createPlatform({ withRegisterTool: true });

    bootstrap(platform);

    const registrations = platform.registerTool.mock.calls.map((call: unknown[]) => (call[0] as { name?: string } | undefined)?.name);
    expect(registrations).toContain("ultraplan_signal");
    expect(registrations).toContain("ultraplan_create");
  });

  test("registers central active-tool controller before context-mode prompt hooks", async () => {
    const bootstrapModulePath = "../../src/bootstrap.js?bootstrap-input-lazy-tools";
    const { bootstrap } = await import(bootstrapModulePath);
    const { platform, handlersByEvent } = createPlatform();

    bootstrap(platform);

    const beforeHandlers = handlersByEvent.get("before_agent_start") ?? [];
    expect(beforeHandlers.length).toBeGreaterThan(1);

    const result = await beforeHandlers[0](
      { prompt: "search repo", systemPrompt: "original prompt" },
      { cwd: process.cwd(), getSystemPrompt: mock(() => "rebuilt prompt") },
    );

    expect(platform.setActiveTools).toHaveBeenCalledWith([
      "bash",
      "ctx_execute",
      "ctx_search",
      "ctx_batch_execute",
      "mcpc_manager",
    ]);
    expect(result).toEqual({ systemPrompt: "rebuilt prompt" });
  });

  test("context-mode prompt hook appends to active-tool rebuilt prompt", async () => {
    const bootstrapModulePath = "../../src/bootstrap.js?bootstrap-input-lazy-tools-context-prompt";
    const { bootstrap } = await import(bootstrapModulePath);
    const { platform, handlersByEvent } = createPlatform();
    const event = { prompt: "search repo", systemPrompt: "original prompt" };

    bootstrap(platform);

    const beforeHandlers = handlersByEvent.get("before_agent_start") ?? [];
    const activeToolResult = await beforeHandlers[0](
      event,
      { cwd: process.cwd(), getSystemPrompt: mock(() => "rebuilt prompt") },
    );

    let contextModeResult: { systemPrompt?: string } | undefined;
    for (const handler of beforeHandlers.slice(1)) {
      const result = await handler(
        event,
        { cwd: process.cwd(), getSystemPrompt: mock(() => activeToolResult?.systemPrompt ?? "") },
      );
      if (result?.systemPrompt?.includes("# supi-context-mode")) {
        contextModeResult = result;
        break;
      }
    }

    expect(contextModeResult?.systemPrompt).toContain("rebuilt prompt");
    expect(contextModeResult?.systemPrompt).not.toContain("original prompt");
    expect(contextModeResult?.systemPrompt).toContain("# supi-context-mode");
  });

  test("uses before_agent_start prompt text for MCP trigger activation", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-bootstrap-mcp-"));
    try {
      const bootstrapModulePath = "../../src/bootstrap.js?bootstrap-input-lazy-tools-mcp";
      const { bootstrap } = await import(bootstrapModulePath);
      const { platform, handlersByEvent } = createPlatform();
      const configPath = platform.paths.project(tmpDir, ".mcp.json");
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          schemaVersion: 1,
          servers: {
            figma: {
              transport: "http",
              activation: "contextual",
              taggable: true,
              triggers: ["figma"],
              antiTriggers: [],
              enabled: true,
              authPending: false,
              addedAt: "2026-04-29T00:00:00.000Z",
            },
          },
        }),
      );

      bootstrap(platform);

      const beforeHandlers = handlersByEvent.get("before_agent_start") ?? [];
      await beforeHandlers[0](
        { prompt: "inspect the figma design", systemPrompt: "original prompt" },
        { cwd: tmpDir, getSystemPrompt: mock(() => "rebuilt prompt") },
      );

      expect(platform.setActiveTools).toHaveBeenCalledWith(expect.arrayContaining(["mcpc_figma"]));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});