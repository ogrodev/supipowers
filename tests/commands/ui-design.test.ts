import { describe, expect, mock, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Platform } from "../../src/platform/types.js";
import { handleUiDesign, type UiDesignCommandDependencies } from "../../src/commands/ui-design.js";
import { cancelPlanTracking, isPlanningActive, startPlanTracking } from "../../src/planning/approval-flow.js";
import { cancelUiDesignTracking, isUiDesignActive, startUiDesignTracking } from "../../src/ui-design/session.js";
import { BackendUnavailableError } from "../../src/ui-design/backend-adapter.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-ui-design-cmd-"));
  cancelPlanTracking();
  cancelUiDesignTracking("test-setup");
});

afterEach(() => {
  cancelPlanTracking();
  cancelUiDesignTracking("test-teardown");
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createPlatform(): Platform {
  return {
    name: "omp",
    registerCommand: mock(),
    getCommands: mock(() => []),
    on: mock(),
    exec: mock(async () => ({ stdout: "", stderr: "", code: 0 })),
    sendMessage: mock(),
    sendUserMessage: mock(),
    getActiveTools: mock(() => []),
    registerMessageRenderer: mock(),
    createAgentSession: mock(),
    paths: {
      dotDir: ".omp",
      dotDirDisplay: ".omp",
      project: (cwd: string, ...segments: string[]) => path.join(cwd, ".omp", "supipowers", ...segments),
      global: (...segments: string[]) => path.join("/home/test", ".omp", "supipowers", ...segments),
      agent: (...segments: string[]) => path.join("/home/test", ".omp", "agent", ...segments),
    },
    capabilities: {
      agentSessions: true,
      compactionHooks: false,
      customWidgets: false,
      registerTool: false,
    },
  } as unknown as Platform;
}

function createContext(overrides: Partial<any> = {}) {
  return {
    cwd: tmpDir,
    hasUI: true,
    ui: {
      select: mock(async () => null),
      input: mock(async () => null),
      notify: mock(),
    },
    ...overrides,
  };
}

function createDeps(overrides: Partial<UiDesignCommandDependencies> = {}): UiDesignCommandDependencies {
  return {
    loadUiDesignConfig: mock(() => ({ backend: "local-html" as const })),
    saveUiDesignConfig: mock(),
    scanDesignContext: mock(async () => ({
      scannedAt: "2026-04-18T00:00:00.000Z",
      tokens: { status: "missing" as const },
      components: { status: "missing" as const, items: [] as [] },
      designMd: { status: "missing" as const },
      packageInfo: { status: "missing" as const },
    })),
    getBackend: mock(() => ({
      id: "local-html" as const,
      startSession: mock(async () => ({ url: "http://localhost:4321", cleanup: mock(async () => {}) })),
      artifactUrl: mock(() => "http://localhost:4321/x"),
      finalize: mock(async () => {}),
    })) as any,
    generateUiDesignSessionId: mock(() => "uidesign-20260418-120000-abcd"),
    createSessionDir: mock((paths, cwd, id) => {
      const dir = paths.project(cwd, "ui-design", id);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    }),
    startUiDesignTracking: mock(),
    notifyInfo: mock(),
    notifyError: mock(),
    applyModelOverride: mock(async () => async () => {}),
    setUiDesignPromptOptions: mock(),
    loadUiDesignPromptAssets: mock(() => ({})),
    ...overrides,
  };
}

describe("handleUiDesign", () => {
  test("loads existing config and skips wizard", async () => {
    const platform = createPlatform();
    const ctx = createContext();
    const deps = createDeps();

    await handleUiDesign(platform, ctx, undefined, deps);

    expect(deps.loadUiDesignConfig).toHaveBeenCalled();
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(deps.saveUiDesignConfig).not.toHaveBeenCalled();
    expect(platform.sendUserMessage).toHaveBeenCalled();
  });

  test("runs wizard when config missing and UI available", async () => {
    const platform = createPlatform();
    const ctx = createContext({
      ui: {
        select: mock(async (title: string) => {
          if (title === "Design backend") return "local-html — Local HTML mockups in browser companion (recommended for v1)";
          return null;
        }),
        input: mock(async () => ""),
        notify: mock(),
      },
    });
    const deps = createDeps({ loadUiDesignConfig: mock(() => null) });

    await handleUiDesign(platform, ctx, undefined, deps);

    expect(deps.saveUiDesignConfig).toHaveBeenCalled();
    expect(platform.sendUserMessage).toHaveBeenCalled();
  });

  test("treats null wizard input as cancellation", async () => {
    const platform = createPlatform();
    const cleanup = mock(async () => {});
    const ctx = createContext({
      ui: {
        select: mock(async () => "local-html — Local HTML mockups in browser companion (recommended for v1)"),
        input: mock(async () => null),
        notify: mock(),
      },
    });
    const deps = createDeps({
      loadUiDesignConfig: mock(() => null),
      applyModelOverride: mock(async () => cleanup),
    });

    await handleUiDesign(platform, ctx, undefined, deps);

    expect(deps.saveUiDesignConfig).not.toHaveBeenCalled();
    expect(platform.sendUserMessage).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  test("aborts with notifyError when config missing and no UI", async () => {
    const platform = createPlatform();
    const ctx = createContext({ hasUI: false });
    const deps = createDeps({ loadUiDesignConfig: mock(() => null) });

    await handleUiDesign(platform, ctx, undefined, deps);

    expect(deps.notifyError).toHaveBeenCalled();
    expect(platform.sendUserMessage).not.toHaveBeenCalled();
  });

  test("cleans up model override on early return before handoff", async () => {
    const platform = createPlatform();
    const cleanup = mock(async () => {});
    const deps = createDeps({
      loadUiDesignConfig: mock(() => null),
      applyModelOverride: mock(async () => cleanup),
    });
    const ctx = createContext({
      ui: {
        select: mock(async () => null),
        input: mock(async () => null),
        notify: mock(),
      },
    });

    await handleUiDesign(platform, ctx, undefined, deps);

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(platform.sendUserMessage).not.toHaveBeenCalled();
  });

  test("cleans up model override when backend startup fails", async () => {
    const platform = createPlatform();
    const ctx = createContext();
    const cleanup = mock(async () => {});
    const deps = createDeps({
      getBackend: mock(() => {
        throw new BackendUnavailableError("nope");
      }) as any,
      applyModelOverride: mock(async () => cleanup),
    });

    await handleUiDesign(platform, ctx, undefined, deps);

    expect(deps.notifyError).toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(platform.sendUserMessage).not.toHaveBeenCalled();
  });

  test("cleans up backend and tracking when a late startup step fails", async () => {
    const platform = createPlatform();
    const ctx = createContext();
    const backendCleanup = mock(async () => {});
    const modelCleanup = mock(async () => {});
    (platform as any).sendUserMessage = mock(() => {
      throw new Error("send failed");
    });
    const deps = createDeps({
      startUiDesignTracking,
      getBackend: mock(() => ({
        id: "local-html" as const,
        startSession: mock(async () => ({ url: "http://localhost:4321", cleanup: backendCleanup })),
        artifactUrl: mock(() => "http://localhost:4321/x"),
        finalize: mock(async () => {}),
      })) as any,
      applyModelOverride: mock(async () => modelCleanup),
    });

    await handleUiDesign(platform, ctx, undefined, deps);

    expect(deps.notifyError).toHaveBeenCalledWith(ctx, "ui-design failed", "send failed");
    expect(backendCleanup).toHaveBeenCalledTimes(1);
    expect(modelCleanup).toHaveBeenCalledTimes(1);
    expect(isUiDesignActive()).toBe(false);
    expect(deps.setUiDesignPromptOptions).toHaveBeenLastCalledWith(null);
  });

  test("starts tracking before sendUserMessage", async () => {
    const platform = createPlatform();
    const ctx = createContext();
    const calls: string[] = [];
    const deps = createDeps({
      startUiDesignTracking: mock(() => {
        calls.push("track");
      }),
    });
    (platform as any).sendUserMessage = mock(() => {
      calls.push("send");
    });

    await handleUiDesign(platform, ctx, undefined, deps);

    expect(calls).toEqual(["track", "send"]);
  });

  test("cancels plan tracking once ui-design handoff succeeds", async () => {
    const platform = createPlatform();
    const ctx = createContext();
    const deps = createDeps();

    startPlanTracking(tmpDir, {
      dotDirDisplay: ".omp",
      project: () => path.join(tmpDir, "plan.md"),
      global: (...segments: string[]) => path.join(tmpDir, "home", ".omp", "supipowers", ...segments),
    } as any);
    expect(isPlanningActive()).toBe(true);

    await handleUiDesign(platform, ctx, undefined, deps);

    expect(platform.sendUserMessage).toHaveBeenCalled();
    expect(isPlanningActive()).toBe(false);
  });

  test("does not clean up model override after successful handoff", async () => {
    const platform = createPlatform();
    const ctx = createContext();
    const cleanup = mock(async () => {});
    const deps = createDeps({
      applyModelOverride: mock(async () => cleanup),
    });

    await handleUiDesign(platform, ctx, undefined, deps);

    expect(platform.sendUserMessage).toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });

  test("loads prompt assets into ui-design prompt options", async () => {
    const platform = createPlatform();
    const ctx = createContext();
    const deps = createDeps({
      loadUiDesignPromptAssets: mock(() => ({
        skillContent: "Skill content",
        subAgentTemplates: [{ name: "component-builder", content: "Template body" }],
      })),
    });

    await handleUiDesign(platform, ctx, undefined, deps);

    expect(deps.setUiDesignPromptOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        skillContent: "Skill content",
        subAgentTemplates: [{ name: "component-builder", content: "Template body" }],
      }),
    );
  });

  test("passes configured component globs into context scan", async () => {
    const platform = createPlatform();
    const ctx = createContext();
    const deps = createDeps({
      loadUiDesignConfig: mock(() => ({
        backend: "local-html" as const,
        componentsGlobs: ["custom-components/**/*.tsx"],
      })),
    });

    await handleUiDesign(platform, ctx, undefined, deps);

    expect(deps.scanDesignContext).toHaveBeenCalledWith(
      tmpDir,
      { components: { globs: ["custom-components/**/*.tsx"] } },
    );
  });

  test("writes initial manifest.json with status: in-progress", async () => {
    const platform = createPlatform();
    const ctx = createContext();
    const deps = createDeps();

    await handleUiDesign(platform, ctx, "landing page", deps);

    const sessionDir = path.join(tmpDir, ".omp", "supipowers", "ui-design", "uidesign-20260418-120000-abcd");
    const manifestPath = path.join(sessionDir, "manifest.json");
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    expect(manifest.status).toBe("in-progress");
    expect(manifest.backend).toBe("local-html");
    expect(manifest.topic).toBe("landing page");
  });

  test("concurrent invocation calls previous cleanup before starting new", async () => {
    const platform = createPlatform();
    const ctx = createContext();

    const firstCleanup = mock(async () => {});
    const secondCleanup = mock(async () => {});

    let callIndex = 0;
    const deps = createDeps({
      // Use the real tracker so the module-level state can run the previous cleanup.
      startUiDesignTracking,
      getBackend: mock(() => ({
        id: "local-html" as const,
        startSession: mock(async () => {
          const cleanup = callIndex === 0 ? firstCleanup : secondCleanup;
          callIndex++;
          return { url: "http://localhost:4321", cleanup };
        }),
        artifactUrl: mock(() => "http://localhost:4321/x"),
        finalize: mock(async () => {}),
      })) as any,
    });

    await handleUiDesign(platform, ctx, undefined, deps);
    await handleUiDesign(platform, ctx, undefined, deps);
    await Promise.resolve();
    await Promise.resolve();

    expect(firstCleanup).toHaveBeenCalledTimes(1);
    expect(secondCleanup).toHaveBeenCalledTimes(0);
  });

  test("wizard offers pencil-mcp as available when Pencil MCP tools are detected", async () => {
    const platform = createPlatform();
    (platform as any).getActiveTools = mock(() => [
      "mcp_pencil_batch_design",
      "mcp_pencil_batch_get",
      "mcp_pencil_open_document",
    ]);
    const state: { offered: string[] | null } = { offered: null };
    const ctx = createContext({
      ui: {
        select: mock(async (_title: string, options: string[]) => {
          state.offered = options;
          return null; // user bails — we only assert the options list
        }),
        input: mock(async () => null),
        notify: mock(),
      },
    });
    const deps = createDeps({ loadUiDesignConfig: mock(() => null) });

    await handleUiDesign(platform, ctx, undefined, deps);

    expect(state.offered).not.toBeNull();
    const labels = state.offered as unknown as string[];
    const pencilLabel = labels.find((l) => l.startsWith("pencil-mcp"));
    expect(pencilLabel).toBeDefined();
    expect(pencilLabel).toContain("Drive a .pen file via the Pencil MCP server");
  });

  test("wizard marks pencil-mcp as not connected when Pencil MCP tools are absent", async () => {
    const platform = createPlatform();
    const state: { offered: string[] | null } = { offered: null };
    const ctx = createContext({
      ui: {
        select: mock(async (_title: string, options: string[]) => {
          state.offered = options;
          return null;
        }),
        input: mock(async () => null),
        notify: mock(),
      },
    });
    const deps = createDeps({ loadUiDesignConfig: mock(() => null) });

    await handleUiDesign(platform, ctx, undefined, deps);

    const labels = state.offered as unknown as string[];
    const pencilLabel = labels.find((l) => l.startsWith("pencil-mcp"));
    expect(pencilLabel).toBeDefined();
    expect(pencilLabel).toContain("not connected");
  });

  test("pencil-mcp flow: selects a .pen file, passes penFilePath to getBackend + manifest", async () => {
    const platform = createPlatform();
    (platform as any).getActiveTools = mock(() => [
      "mcp_pencil_batch_design",
      "mcp_pencil_batch_get",
    ]);
    // Pre-create a .pen file in the tmp repo so the selector discovers it.
    const penAbs = path.join(tmpDir, "designs", "home.pen");
    fs.mkdirSync(path.dirname(penAbs), { recursive: true });
    fs.writeFileSync(penAbs, "");

    const ctx = createContext({
      ui: {
        // headless path: we test with hasUI:false so the selector picks the first
        // alphabetical entry deterministically without asking.
        select: mock(async () => null),
        input: mock(async () => null),
        notify: mock(),
      },
      hasUI: false,
    });

    const captured: { startSessionArgs: any; getBackendArgs: any[] | null } = {
      startSessionArgs: null,
      getBackendArgs: null,
    };
    const deps = createDeps({
      loadUiDesignConfig: mock(() => ({ backend: "pencil-mcp" as const })),
      getBackend: mock((...args: any[]) => {
        captured.getBackendArgs = args;
        return {
          id: "pencil-mcp" as const,
          startSession: mock(async (opts: any) => {
            captured.startSessionArgs = opts;
            return { url: `file://${opts.penFilePath}`, cleanup: mock(async () => {}) };
          }),
          artifactUrl: mock(() => null),
          finalize: mock(async () => {}),
        };
      }) as any,
    });

    await handleUiDesign(platform, ctx, undefined, deps);

    expect(captured.getBackendArgs?.[0]).toBe("pencil-mcp");
    expect(typeof captured.getBackendArgs?.[1]?.getActiveTools).toBe("function");
    expect(captured.startSessionArgs?.penFilePath).toBe(penAbs);

    const sessionDir = path.join(tmpDir, ".omp", "supipowers", "ui-design", "uidesign-20260418-120000-abcd");
    const manifest = JSON.parse(fs.readFileSync(path.join(sessionDir, "manifest.json"), "utf-8"));
    expect(manifest.backend).toBe("pencil-mcp");
    expect(manifest.penFilePath).toBe(penAbs);

    expect(deps.setUiDesignPromptOptions).toHaveBeenCalledWith(
      expect.objectContaining({ backend: "pencil-mcp", penFilePath: penAbs }),
    );
  });

  test("loadUiDesignPromptAssets receives backend context for pencil sessions", async () => {
    const platform = createPlatform();
    (platform as any).getActiveTools = mock(() => [
      "mcp_pencil_batch_design",
      "mcp_pencil_batch_get",
    ]);
    const ctx = createContext({ hasUI: false });
    const loadUiDesignPromptAssets = mock(() => ({}));
    const deps = createDeps({
      loadUiDesignConfig: mock(() => ({ backend: "pencil-mcp" as const })),
      loadUiDesignPromptAssets,
      getBackend: mock(() => ({
        id: "pencil-mcp" as const,
        startSession: mock(async () => ({ url: "file:///x", cleanup: mock(async () => {}) })),
        artifactUrl: mock(() => null),
        finalize: mock(async () => {}),
      })) as any,
    });

    await handleUiDesign(platform, ctx, undefined, deps);

    expect(loadUiDesignPromptAssets).toHaveBeenCalledWith({ backend: "pencil-mcp" });
  });

  test("wizard survives when platform.getActiveTools throws", async () => {
    const platform = createPlatform();
    (platform as any).getActiveTools = mock(() => {
      throw new Error("tool bridge unavailable");
    });
    const state: { offered: string[] | null } = { offered: null };
    const ctx = createContext({
      ui: {
        select: mock(async (_title: string, options: string[]) => {
          state.offered = options;
          return null;
        }),
        input: mock(async () => null),
        notify: mock(),
      },
    });
    const deps = createDeps({ loadUiDesignConfig: mock(() => null) });

    await handleUiDesign(platform, ctx, undefined, deps);

    const labels = state.offered as unknown as string[];
    expect(labels).toBeDefined();
    expect(labels.some((l) => l.startsWith("local-html"))).toBe(true);
    const pencilLabel = labels.find((l) => l.startsWith("pencil-mcp"));
    expect(pencilLabel).toContain("not connected");
    // Must not have surfaced an error banner — the wizard kept going.
    expect(deps.notifyError).not.toHaveBeenCalled();
  });

  test("pencil flow removes the session dir when the user cancels .pen selection", async () => {
    const platform = createPlatform();
    (platform as any).getActiveTools = mock(() => [
      "mcp_pencil_batch_design",
      "mcp_pencil_batch_get",
    ]);
    // Pre-create a .pen so the selector would have non-trivial options, but
    // cancel the prompt — we want to exercise the cleanup path.
    fs.mkdirSync(path.join(tmpDir, "designs"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "designs", "home.pen"), "");
    const ctx = createContext({
      ui: {
        select: mock(async () => null), // user cancels the .pen picker
        input: mock(async () => null),
        notify: mock(),
      },
    });
    const deps = createDeps({
      loadUiDesignConfig: mock(() => ({ backend: "pencil-mcp" as const })),
    });

    await handleUiDesign(platform, ctx, undefined, deps);

    const sessionDir = path.join(tmpDir, ".omp", "supipowers", "ui-design", "uidesign-20260418-120000-abcd");
    expect(fs.existsSync(sessionDir)).toBe(false);
    expect(deps.notifyInfo).toHaveBeenCalledWith(ctx, "ui-design cancelled", "No .pen file selected");
    expect(platform.sendUserMessage).not.toHaveBeenCalled();
  });
});