import { describe, expect, mock, test } from "bun:test";
import type { Platform } from "../../src/platform/types.js";
import type { InspectionLoadResult } from "../../src/config/schema.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { showStatusDialog } from "../../src/commands/status.js";

function createPlatform(): Platform {
  return {
    name: "omp",
    registerCommand: mock(),
    getCommands: mock(() => []),
    on: mock(),
    exec: mock(),
    sendMessage: mock(),
    sendUserMessage: mock(),
    getActiveTools: mock(() => []),
    registerMessageRenderer: mock(),
    createAgentSession: mock(),
    paths: {
      dotDir: ".omp",
      dotDirDisplay: ".omp",
      project: (_cwd: string, ...segments: string[]) => segments.join("/"),
      global: (...segments: string[]) => segments.join("/"),
      agent: (...segments: string[]) => segments.join("/"),
    },
    capabilities: {
      agentSessions: true,
      compactionHooks: false,
      customWidgets: false,
      registerTool: false,
    },
  } as unknown as Platform;
}

function createInspection(overrides: Partial<InspectionLoadResult> = {}): InspectionLoadResult {
  return {
    mergedConfig: DEFAULT_CONFIG as unknown as Record<string, unknown>,
    effectiveConfig: {
      ...DEFAULT_CONFIG,
      quality: { gates: { "lsp-diagnostics": { enabled: true } } },
    },
    parseErrors: [],
    validationErrors: [],
    ...overrides,
  };
}

describe("showStatusDialog", () => {
  test("shows enabled gates instead of profile", async () => {
    const platform = createPlatform();
    const ctx = {
      cwd: "/repo",
      hasUI: true,
      ui: { select: mock(async () => null), notify: mock() },
    } as any;

    await showStatusDialog(platform, ctx, {
      inspectConfig: mock(() => createInspection()),
      listPlans: mock(() => []),
    });

    expect(ctx.ui.select).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([expect.stringContaining("Gates:")]),
      expect.anything(),
    );
  });

  test("surfaces config inspection errors instead of throwing", async () => {
    const platform = createPlatform();
    const ctx = {
      cwd: "/repo",
      hasUI: true,
      ui: { select: mock(async () => null), notify: mock() },
    } as any;

    await showStatusDialog(platform, ctx, {
      inspectConfig: mock(() =>
        createInspection({
          mergedConfig: {},
          effectiveConfig: null,
          parseErrors: [
            {
              source: "project",
              path: ".omp/supipowers/config.json",
              message: "Unexpected token",
            },
          ],
        }),
      ),
      listPlans: mock(() => []),
    });

    expect(ctx.ui.select).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([expect.stringContaining("Config error")]),
      expect.anything(),
    );
  });
});
