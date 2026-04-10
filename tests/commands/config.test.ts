import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createPaths, type Platform } from "../../src/platform/types.js";
import { buildSettings } from "../../src/commands/config.js";
import { inspectConfig, updateConfig } from "../../src/config/loader.js";
import type { InspectionLoadResult } from "../../src/config/schema.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";

function createTestPaths(rootDir: string): ReturnType<typeof createPaths> {
  return {
    dotDir: ".omp",
    dotDirDisplay: ".omp",
    project: (cwd: string, ...segments: string[]) =>
      path.join(cwd, ".omp", "supipowers", ...segments),
    global: (...segments: string[]) =>
      path.join(rootDir, "global-config", ".omp", "supipowers", ...segments),
    agent: (...segments: string[]) => path.join(rootDir, "agent", ...segments),
  };
}

function createPlatform(localPaths: ReturnType<typeof createPaths>): Platform {
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
    paths: localPaths,
    capabilities: {
      agentSessions: true,
      compactionHooks: false,
      customWidgets: false,
      registerTool: false,
    },
  } as unknown as Platform;
}

function writeProjectConfig(localPaths: ReturnType<typeof createPaths>, cwd: string, data: unknown): void {
  const filePath = localPaths.project(cwd, "config.json");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function readProjectConfig(localPaths: ReturnType<typeof createPaths>, cwd: string): unknown {
  return JSON.parse(fs.readFileSync(localPaths.project(cwd, "config.json"), "utf-8"));
}

describe("buildSettings", () => {
  let tmpDir: string;
  let localPaths: ReturnType<typeof createPaths>;
  let platform: Platform;
  let ctx: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-config-test-"));
    localPaths = createTestPaths(tmpDir);
    platform = createPlatform(localPaths);
    ctx = {
      cwd: tmpDir,
      hasUI: true,
      ui: {
        select: mock(),
        notify: mock(),
        input: mock(),
      },
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("quality gate setup rejects invalid AI suggestions and preserves file", async () => {
    const originalConfig = { notifications: { verbosity: "quiet" } };
    writeProjectConfig(localPaths, tmpDir, originalConfig);

    const inspection = inspectConfig(localPaths, tmpDir);
    const deps = {
      inspectConfig: mock(() => inspection),
      updateConfig: mock(updateConfig),
      setupGates: mock(async () => ({
        status: "invalid" as const,
        proposal: { gates: { "test-suite": { enabled: true } } as any },
        errors: ["test-suite.command: Expected string"],
      })),
      interactivelySaveGateSetup: mock(async () => "saved" as const),
      checkInstallation: mock(async () => ({ cliInstalled: false, mcpConfigured: false, toolsAvailable: false })),
    };

    const settings = buildSettings(platform, ctx, inspection, deps as any);
    const qualitySetting = settings.find((setting) => setting.key === "quality.gates");
    if (!qualitySetting) throw new Error("Missing quality.gates setting");

    await qualitySetting.set(tmpDir, "Run AI-assisted setup");

    expect(ctx.ui.notify).toHaveBeenCalledWith("test-suite.command: Expected string", "error");
    expect(deps.interactivelySaveGateSetup).not.toHaveBeenCalled();
    expect(readProjectConfig(localPaths, tmpDir)).toEqual(originalConfig);
  });

  test("qa framework setting persists only qa.framework", async () => {
    const inspection: InspectionLoadResult = {
      mergedConfig: DEFAULT_CONFIG as unknown as Record<string, unknown>,
      effectiveConfig: DEFAULT_CONFIG,
      parseErrors: [],
      validationErrors: [],
    };
    const deps = {
      inspectConfig: mock(() => inspection),
      updateConfig: mock(updateConfig),
      setupGates: mock(),
      interactivelySaveGateSetup: mock(),
      checkInstallation: mock(async () => ({ cliInstalled: false, mcpConfigured: false, toolsAvailable: false })),
    };

    const settings = buildSettings(platform, ctx, inspection, deps as any);
    const qaSetting = settings.find((setting) => setting.key === "qa.framework");
    if (!qaSetting) throw new Error("Missing qa.framework setting");

    await qaSetting.set(tmpDir, "npm-test — npm test");

    const saved = readProjectConfig(localPaths, tmpDir) as { qa?: { framework?: string; command?: string } };
    expect(saved.qa?.framework).toBe("npm-test");
    expect(saved.qa && "command" in saved.qa).toBe(false);
  });
});
