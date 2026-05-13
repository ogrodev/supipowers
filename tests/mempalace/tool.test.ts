import { describe, expect, mock, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { registerMempalaceTool, type MempalaceToolDeps } from "../../src/mempalace/tool.js";
import { createMockPlatform } from "../../src/platform/test-utils.js";
import type { MempalaceInstallSnapshot } from "../../src/mempalace/installer-helper.js";
import { MEMPALACE_PACKAGE_VERSION } from "../../src/mempalace/upstream-limits.js";

function createPlatformWithTool() {
  return createMockPlatform({ registerTool: mock() as any });
}

function readyInstallSnapshot(): MempalaceInstallSnapshot {
  return {
    enabled: true,
    packageVersion: "test",
    managedBinDir: "/tmp/bin",
    uvPath: "/tmp/bin/uv",
    uvInstalled: true,
    venvPath: "/tmp/venv",
    venvPython: "/tmp/venv/bin/python",
    venvInstalled: true,
    bridgeOk: true,
    bridgePath: "/tmp/bridge.py",
    ready: true,
  };
}

function withReadyInstall(deps: Omit<MempalaceToolDeps, "snapshotInstall"> = {}): MempalaceToolDeps {
  return { ...deps, snapshotInstall: () => readyInstallSnapshot() };
}


describe("registerMempalaceTool", () => {
  test("registers exactly one native mempalace tool with schema and description", () => {
    const platform = createPlatformWithTool();

    registerMempalaceTool(platform, DEFAULT_CONFIG, withReadyInstall());

    expect(platform.registerTool).toHaveBeenCalledTimes(1);
    const definition = (platform.registerTool as any).mock.calls[0][0];
    expect(definition.name).toBe("mempalace");
    expect(definition.parameters.properties.action.enum).toContain("search");
    expect(definition.description).toContain("MemPalace memory dispatcher");
    expect(definition.description).toContain("**MUST** call `search`");
  });

  test("validates params before dispatch", async () => {
    const platform = createPlatformWithTool();
    const executeBridge = mock(async () => ({ ok: true, action: "search", result: {}, diagnostics: {} }));
    registerMempalaceTool(platform, DEFAULT_CONFIG, withReadyInstall({
      createBridge: () => ({ execute: executeBridge as any }),
    }));
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
    registerMempalaceTool(platform, DEFAULT_CONFIG, withReadyInstall({
      createBridge: () => ({ execute: executeBridge as any }),
    }));
    const definition = (platform.registerTool as any).mock.calls[0][0];

    const result = await definition.execute("tool-call", { action: "status" }, new AbortController().signal, undefined, { cwd: process.cwd() });

    expect(executeBridge).toHaveBeenCalledWith({ action: "status" });
    expect(result.content[0].text).toContain("MemPalace status");
    expect(result.details).toMatchObject({ ok: true, action: "status", diagnostics: { durationMs: 5 } });
  });

  test("formats bridge errors with structured details", async () => {
    const platform = createPlatformWithTool();
    registerMempalaceTool(platform, DEFAULT_CONFIG, withReadyInstall({
      createBridge: () => ({
        execute: async () => ({
          ok: false,
          action: "search",
          error: { code: "palace_missing", message: "No palace", remediation: "Run init" },
          diagnostics: { durationMs: 3 },
        }),
      }),
    }));
    const definition = (platform.registerTool as any).mock.calls[0][0];

    const result = await definition.execute("tool-call", { action: "search", query: "x" }, new AbortController().signal, undefined, { cwd: process.cwd() });

    expect(result.content[0].text).toContain("palace_missing");
    expect(result.content[0].text).toContain("Run init");
    expect(result.details).toMatchObject({ ok: false, action: "search", error: { code: "palace_missing" } });
  });

  test("runs setup with progress updates and structured details", async () => {
    const platform = createPlatformWithTool();
    const updates: unknown[] = [];
    registerMempalaceTool(platform, DEFAULT_CONFIG, withReadyInstall({
      resolveBridgeScriptPath: () => ({ ok: true, path: "/bridge.py" }),
      setupRuntime: async (_options) => {
        _options.onProgress?.(`Installing mempalace==${MEMPALACE_PACKAGE_VERSION} from PyPI`);
        return { ok: true, details: { packageVersion: MEMPALACE_PACKAGE_VERSION, venvPath: "/venv" } } as any;
      },
    }));
    const definition = (platform.registerTool as any).mock.calls[0][0];

    const result = await definition.execute("tool-call", { action: "setup" }, new AbortController().signal, (update: unknown) => updates.push(update), { cwd: process.cwd() });

    expect(updates).toEqual([
      { content: [{ type: "text", text: `Installing mempalace==${MEMPALACE_PACKAGE_VERSION} from PyPI` }] },
    ]);
    expect(result.content[0].text).toContain("setup");
    expect(result.details).toMatchObject({ ok: true, action: "setup", setup: { packageVersion: MEMPALACE_PACKAGE_VERSION } });
  });

  test("returns a valid tool result when the bridge throws unexpectedly", async () => {
    const platform = createPlatformWithTool();
    registerMempalaceTool(platform, DEFAULT_CONFIG, withReadyInstall({
      createBridge: () => ({
        execute: async () => {
          throw new Error("synthetic bridge crash");
        },
      }),
    }));
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
    registerMempalaceTool(platform, DEFAULT_CONFIG, withReadyInstall({
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
    }));
    const definition = (platform.registerTool as any).mock.calls[0][0];

    const result = await definition.execute("tool-call", { action: "status" }, new AbortController().signal, undefined, { cwd: process.cwd() });

    expect(result.content[0].text).toContain("bridge_protocol_error");
    expect(result.content[0].text).toContain("Bridge stderr:");
    expect(result.content[0].text).toContain("ImportError: numpy.core.multiarray failed to import");
    expect(result.content[0].text).toContain("Bridge stdout (preview):");
    expect(result.content[0].text).toContain("chromadb telemetry banner");
  });

  test("does not register when mempalace.enabled is false (no install probe)", () => {
    const platform = createPlatformWithTool();
    const probe = mock(() => readyInstallSnapshot());
    const config = { ...DEFAULT_CONFIG, mempalace: { ...DEFAULT_CONFIG.mempalace, enabled: false } };

    registerMempalaceTool(platform, config, { snapshotInstall: probe });

    expect(platform.registerTool).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  test("does not register when install snapshot reports not ready", () => {
    const platform = createPlatformWithTool();
    const notReady: MempalaceInstallSnapshot = {
      ...readyInstallSnapshot(),
      uvInstalled: false,
      ready: false,
    };

    registerMempalaceTool(platform, DEFAULT_CONFIG, { snapshotInstall: () => notReady });

    expect(platform.registerTool).not.toHaveBeenCalled();
  });

  test("does not register when the install probe throws", () => {
    const platform = createPlatformWithTool();
    (platform as any).logger = { warn: mock(), error: mock(), debug: mock() };

    registerMempalaceTool(platform, DEFAULT_CONFIG, {
      snapshotInstall: () => { throw new Error("fs unavailable"); },
    });

    expect(platform.registerTool).not.toHaveBeenCalled();
    expect((platform as any).logger.warn).toHaveBeenCalled();
  });

  test("registers when install snapshot reports ready", () => {
    const platform = createPlatformWithTool();
    const probe = mock(() => readyInstallSnapshot());

    registerMempalaceTool(platform, DEFAULT_CONFIG, { snapshotInstall: probe });

    expect(platform.registerTool).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
