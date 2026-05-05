import { describe, expect, mock, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { registerMempalaceTool } from "../../src/mempalace/tool.js";
import { createMockPlatform } from "../../src/platform/test-utils.js";

function createPlatformWithTool() {
  return createMockPlatform({ registerTool: mock() as any });
}


describe("registerMempalaceTool", () => {
  test("registers exactly one native mempalace tool with schema and description", () => {
    const platform = createPlatformWithTool();

    registerMempalaceTool(platform, DEFAULT_CONFIG);

    expect(platform.registerTool).toHaveBeenCalledTimes(1);
    const definition = (platform.registerTool as any).mock.calls[0][0];
    expect(definition.name).toBe("mempalace");
    expect(definition.parameters.properties.action.enum).toContain("search");
    expect(definition.description).toContain("one native MemPalace action");
  });

  test("validates params before dispatch", async () => {
    const platform = createPlatformWithTool();
    const executeBridge = mock(async () => ({ ok: true, action: "search", result: {}, diagnostics: {} }));
    registerMempalaceTool(platform, DEFAULT_CONFIG, {
      createBridge: () => ({ execute: executeBridge as any }),
    });
    const definition = (platform.registerTool as any).mock.calls[0][0];

    const result = await definition.execute("tool-call", { action: "search" }, new AbortController().signal, undefined, { cwd: process.cwd() });

    expect(executeBridge).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("query is required for action search");
    expect(result.details.ok).toBe(false);
  });

  test("dispatches through the bridge and formats successful results", async () => {
    const platform = createPlatformWithTool();
    const executeBridge = mock(async () => ({
      ok: true,
      action: "status",
      result: { ready: true, palacePath: "/tmp/palace", wings: ["supipowers"] },
      diagnostics: { durationMs: 5 },
    }));
    registerMempalaceTool(platform, DEFAULT_CONFIG, {
      createBridge: () => ({ execute: executeBridge as any }),
    });
    const definition = (platform.registerTool as any).mock.calls[0][0];

    const result = await definition.execute("tool-call", { action: "status" }, new AbortController().signal, undefined, { cwd: process.cwd() });

    expect(executeBridge).toHaveBeenCalledWith({ action: "status" });
    expect(result.content[0].text).toContain("MemPalace status");
    expect(result.details).toMatchObject({ ok: true, action: "status", diagnostics: { durationMs: 5 } });
  });

  test("formats bridge errors with structured details", async () => {
    const platform = createPlatformWithTool();
    registerMempalaceTool(platform, DEFAULT_CONFIG, {
      createBridge: () => ({
        execute: async () => ({
          ok: false,
          action: "search",
          error: { code: "palace_missing", message: "No palace", remediation: "Run init" },
          diagnostics: { durationMs: 3 },
        }),
      }),
    });
    const definition = (platform.registerTool as any).mock.calls[0][0];

    const result = await definition.execute("tool-call", { action: "search", query: "x" }, new AbortController().signal, undefined, { cwd: process.cwd() });

    expect(result.content[0].text).toContain("palace_missing");
    expect(result.content[0].text).toContain("Run init");
    expect(result.details).toMatchObject({ ok: false, action: "search", error: { code: "palace_missing" } });
  });

  test("runs setup with progress updates and structured details", async () => {
    const platform = createPlatformWithTool();
    const updates: unknown[] = [];
    registerMempalaceTool(platform, DEFAULT_CONFIG, {
      resolveBridgeScriptPath: () => ({ ok: true, path: "/bridge.py" }),
      setupRuntime: async (_options) => {
        _options.onProgress?.("Installing mempalace==3.3.4 from PyPI");
        return { ok: true, details: { packageVersion: "3.3.4", venvPath: "/venv" } } as any;
      },
    });
    const definition = (platform.registerTool as any).mock.calls[0][0];

    const result = await definition.execute("tool-call", { action: "setup" }, new AbortController().signal, (update: unknown) => updates.push(update), { cwd: process.cwd() });

    expect(updates).toEqual([
      { content: [{ type: "text", text: "Installing mempalace==3.3.4 from PyPI" }] },
    ]);
    expect(result.content[0].text).toContain("setup");
    expect(result.details).toMatchObject({ ok: true, action: "setup", setup: { packageVersion: "3.3.4" } });
  });

  test("returns a valid tool result when the bridge throws unexpectedly", async () => {
    const platform = createPlatformWithTool();
    registerMempalaceTool(platform, DEFAULT_CONFIG, {
      createBridge: () => ({
        execute: async () => {
          throw new Error("synthetic bridge crash");
        },
      }),
    });
    const definition = (platform.registerTool as any).mock.calls[0][0];

    const result = await definition.execute("tool-call", { action: "status" }, new AbortController().signal, undefined, { cwd: process.cwd() });

    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("MemPalace tool crashed");
    expect(result.content[0].text).toContain("synthetic bridge crash");
    expect(result.details).toMatchObject({ ok: false, error: { code: "tool_crash" } });
  });

  test("surfaces bridge stderr/stdout in error text so users can debug bridge_protocol_error", async () => {
    const platform = createPlatformWithTool();
    registerMempalaceTool(platform, DEFAULT_CONFIG, {
      createBridge: () => ({
        execute: async () => ({
          ok: false,
          action: "status",
          error: { code: "bridge_protocol_error", message: "MemPalace bridge returned malformed JSON on stdout." },
          diagnostics: {
            stderrTail: "ImportError: numpy.core.multiarray failed to import",
            stdoutPreview: "<warning>chromadb telemetry banner</warning>",
          },
        }),
      }),
    });
    const definition = (platform.registerTool as any).mock.calls[0][0];

    const result = await definition.execute("tool-call", { action: "status" }, new AbortController().signal, undefined, { cwd: process.cwd() });

    expect(result.content[0].text).toContain("bridge_protocol_error");
    expect(result.content[0].text).toContain("Bridge stderr:");
    expect(result.content[0].text).toContain("ImportError: numpy.core.multiarray failed to import");
    expect(result.content[0].text).toContain("Bridge stdout (preview):");
    expect(result.content[0].text).toContain("chromadb telemetry banner");
  });
});
