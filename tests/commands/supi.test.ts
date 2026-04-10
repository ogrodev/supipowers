import { describe, expect, mock, test } from "bun:test";
import type { Platform } from "../../src/platform/types.js";
import type { InspectionLoadResult } from "../../src/config/schema.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { showSupiDialog } from "../../src/commands/supi.js";
import type { ReviewReport } from "../../src/types.js";

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

function createReport(overrides: Partial<ReviewReport> = {}): ReviewReport {
  return {
    timestamp: "2026-04-10T00:00:00.000Z",
    selectedGates: [],
    gates: [],
    summary: { passed: 1, failed: 0, skipped: 0, blocked: 1 },
    overallStatus: "blocked",
    ...overrides,
  };
}

describe("showSupiDialog", () => {
  test("shows aggregate review status", async () => {
    const platform = createPlatform();
    const ctx = {
      cwd: "/repo",
      hasUI: true,
      ui: { select: mock(async () => null), notify: mock() },
    } as any;

    await showSupiDialog(platform, ctx, {
      inspectConfig: mock(() => createInspection()),
      loadLatestReport: mock(() => createReport()),
      listPlans: mock(() => []),
    });

    expect(ctx.ui.select).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([expect.stringContaining("Last review: 2026-04-10 (blocked)")]),
      expect.anything(),
    );
  });
});
