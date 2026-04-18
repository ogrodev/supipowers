import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createPaths, type Platform } from "../../src/platform/types.js";
import {
  buildConfigScopeView,
  buildSettings,
  runConfigMenu,
  type ConfigScopeSelection,
} from "../../src/commands/config.js";
import { inspectConfig, updateConfig } from "../../src/config/loader.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type { ConfigScope } from "../../src/types.js";

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
    exec: mock(async () => ({ code: 1, stdout: "", stderr: "" })),
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

function writeJsonFile(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function writeProjectConfig(localPaths: ReturnType<typeof createPaths>, cwd: string, data: unknown): void {
  writeJsonFile(localPaths.project(cwd, "config.json"), data);
}

function writeGlobalConfig(localPaths: ReturnType<typeof createPaths>, data: unknown): void {
  writeJsonFile(localPaths.global("config.json"), data);
}

function readProjectConfig(localPaths: ReturnType<typeof createPaths>, cwd: string): unknown {
  return JSON.parse(fs.readFileSync(localPaths.project(cwd, "config.json"), "utf-8"));
}

function readGlobalConfig(localPaths: ReturnType<typeof createPaths>): unknown {
  return JSON.parse(fs.readFileSync(localPaths.global("config.json"), "utf-8"));
}

function workspaceConfigPath(
  localPaths: ReturnType<typeof createPaths>,
  repoRoot: string,
  workspaceRelativeDir: string,
): string {
  return localPaths.project(
    repoRoot,
    "workspaces",
    ...workspaceRelativeDir.split("/"),
    "config.json",
  );
}

function createScopeView(
  platform: Platform,
  scope: ConfigScope,
  repoRoot: string,
  isMonorepo = false,
) {
  const selection: ConfigScopeSelection = { scope, repoRoot, isMonorepo };
  return buildConfigScopeView(platform, repoRoot, selection);
}

describe("config command settings", () => {
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

  test("quality gate setup rejects invalid AI suggestions and preserves repository config", async () => {
    const originalConfig = { lsp: { setupGuide: false } };
    writeProjectConfig(localPaths, tmpDir, originalConfig);

    const inspect = mock((paths: Platform["paths"], cwd: string, options?: any) => inspectConfig(paths, cwd, options));
    const deps = {
      inspectConfig: inspect,
      updateConfig: mock(updateConfig),
      setupGates: mock(async () => ({
        status: "invalid" as const,
        proposal: { gates: { "test-suite": { enabled: true } } as any },
        errors: ["test-suite.command: Expected string"],
      })),
    };

    const settings = buildSettings(platform, ctx, createScopeView(platform, "root", tmpDir), deps as any);
    const qualitySetting = settings.find((setting) => setting.key === "quality.gates");
    if (!qualitySetting) throw new Error("Missing quality.gates setting");

    await qualitySetting.set(tmpDir, "Run AI-assisted setup");

    expect(ctx.ui.notify).toHaveBeenCalledWith("test-suite.command: Expected string", "error");
    expect(readProjectConfig(localPaths, tmpDir)).toEqual(originalConfig);
  });

  test("quality gate setup saves to the shared repository scope in monorepos", async () => {
    const workspaceDir = path.join(tmpDir, "packages", "pkg-a");
    fs.mkdirSync(workspaceDir, { recursive: true });
    ctx.cwd = workspaceDir;
    ctx.ui.select = mock(async () => "Accept");

    const inspect = mock((paths: Platform["paths"], cwd: string, options?: any) => inspectConfig(paths, cwd, options));
    const deps = {
      inspectConfig: inspect,
      updateConfig: mock(updateConfig),
      setupGates: mock(async () => ({
        status: "proposed" as const,
        proposal: {
          gates: { "lsp-diagnostics": { enabled: true } },
          notes: ["Typecheck: Detected typecheck commands in workspace targets only."],
        },
      })),
    };

    const settings = buildSettings(
      platform,
      ctx,
      createScopeView(platform, "root", tmpDir, true),
      deps as any,
    );
    const qualitySetting = settings.find((setting) => setting.key === "quality.gates");
    if (!qualitySetting) throw new Error("Missing quality.gates setting");

    const result = await qualitySetting.set(workspaceDir, "Run deterministic setup");

    expect(result).toBe("saved");
    expect(readProjectConfig(localPaths, tmpDir)).toEqual({
      quality: { gates: { "lsp-diagnostics": { enabled: true } } },
    });
    expect(fs.existsSync(localPaths.global("config.json"))).toBe(false);
    expect(deps.setupGates).toHaveBeenCalledWith(
      platform,
      tmpDir,
      expect.anything(),
      expect.objectContaining({ mode: "deterministic" }),
    );
    expect(ctx.ui.select).toHaveBeenCalledWith(
      "Quality gate setup",
      ["Accept", "Revise", "Cancel"],
      expect.objectContaining({
        helpText: expect.stringContaining("workspace targets only"),
      }),
    );
  });

  test("settings no longer expose Default profile", () => {
    const settings = buildSettings(platform, ctx, createScopeView(platform, "root", tmpDir), {
      inspectConfig,
      updateConfig: mock(updateConfig),
      setupGates: mock(),
    } as any);

    expect(settings.map((setting) => setting.label)).not.toContain("Default profile");
  });

  test("lsp setup guide writes to the selected global scope only", async () => {
    const settings = buildSettings(platform, ctx, createScopeView(platform, "global", tmpDir), {
      inspectConfig,
      updateConfig: mock(updateConfig),
      setupGates: mock(),
    } as any);
    const lspSetting = settings.find((setting) => setting.key === "lsp.setupGuide");
    if (!lspSetting) throw new Error("Missing lsp.setupGuide setting");

    await lspSetting.set(tmpDir, "off");

    expect(readGlobalConfig(localPaths)).toEqual({ lsp: { setupGuide: false } });
    expect(fs.existsSync(localPaths.project(tmpDir, "config.json"))).toBe(false);
  });

  test("qa framework setting persists only qa.framework in repository scope", async () => {
    const settings = buildSettings(platform, ctx, createScopeView(platform, "root", tmpDir), {
      inspectConfig,
      updateConfig: mock(updateConfig),
      setupGates: mock(),
    } as any);
    const qaSetting = settings.find((setting) => setting.key === "qa.framework");
    if (!qaSetting) throw new Error("Missing qa.framework setting");

    await qaSetting.set(tmpDir, "npm-test — npm test");

    const saved = readProjectConfig(localPaths, tmpDir) as { qa?: { framework?: string; command?: string } };
    expect(saved.qa?.framework).toBe("npm-test");
    expect(saved.qa && "command" in saved.qa).toBe(false);
    expect(fs.existsSync(localPaths.global("config.json"))).toBe(false);
  });

  test("release channels setting writes to the shared repository scope only", async () => {
    const settings = buildSettings(
      platform,
      ctx,
      createScopeView(platform, "root", tmpDir, true),
      {
        inspectConfig,
        updateConfig: mock(updateConfig),
        setupGates: mock(),
      } as any,
    );
    const releaseSetting = settings.find((setting) => setting.key === "release.channels");
    if (!releaseSetting || !releaseSetting.options) throw new Error("Missing release.channels setting");

    expect(releaseSetting.options).toEqual([
      "not set — auto-detect on first /supi:release run",
      "github — GitHub Release with gh CLI",
    ]);

    await releaseSetting.set(tmpDir, "github — GitHub Release with gh CLI");

    const saved = readProjectConfig(localPaths, tmpDir) as { release?: { channels?: string[] } };
    expect(saved.release?.channels).toEqual(["github"]);
    expect(fs.existsSync(localPaths.global("config.json"))).toBe(false);
  });

  test("repository settings show inherited provenance from global", () => {
    writeGlobalConfig(localPaths, { lsp: { setupGuide: false } });

    const settings = buildSettings(platform, ctx, createScopeView(platform, "root", tmpDir, true), {
      inspectConfig,
      updateConfig: mock(updateConfig),
      setupGates: mock(),
    } as any);
    const lspSetting = settings.find((setting) => setting.key === "lsp.setupGuide");
    if (!lspSetting) throw new Error("Missing lsp.setupGuide setting");

    expect(lspSetting.get()).toBe("off — inherited from global");
  });

  test("repository settings show repository overrides", () => {
    writeGlobalConfig(localPaths, { lsp: { setupGuide: false } });
    writeProjectConfig(localPaths, tmpDir, { lsp: { setupGuide: true } });

    const settings = buildSettings(platform, ctx, createScopeView(platform, "root", tmpDir, true), {
      inspectConfig,
      updateConfig: mock(updateConfig),
      setupGates: mock(),
    } as any);
    const lspSetting = settings.find((setting) => setting.key === "lsp.setupGuide");
    if (!lspSetting) throw new Error("Missing lsp.setupGuide setting");

    expect(lspSetting.get()).toBe("on — overridden in repository");
  });

  test("global scope view ignores repository overrides", () => {
    writeGlobalConfig(localPaths, { lsp: { setupGuide: false } });
    writeProjectConfig(localPaths, tmpDir, { lsp: { setupGuide: true } });

    const settings = buildSettings(platform, ctx, createScopeView(platform, "global", tmpDir), {
      inspectConfig,
      updateConfig: mock(updateConfig),
      setupGates: mock(),
    } as any);
    const globalLsp = settings.find((setting) => setting.key === "lsp.setupGuide");
    if (!globalLsp) throw new Error("Missing global lsp.setupGuide setting");

    expect(globalLsp.get()).toBe("off — overridden in global");
  });

  test("runConfigMenu defaults to repository scope and hides workspace-specific choices in monorepos", async () => {
    const workspaceDir = path.join(tmpDir, "packages", "pkg-a");
    writeJsonFile(path.join(tmpDir, "package.json"), {
      name: "repo-root",
      version: "1.0.0",
      private: true,
      workspaces: ["packages/*"],
      packageManager: "bun@1.2.0",
    });
    writeJsonFile(path.join(workspaceDir, "package.json"), {
      name: "pkg-a",
      version: "1.0.0",
      private: true,
    });
    writeJsonFile(path.join(tmpDir, "packages/pkg-b/package.json"), {
      name: "pkg-b",
      version: "1.0.0",
      private: true,
    });
    ctx.cwd = workspaceDir;
    platform.exec = mock(async (command: string, args: string[]) => {
      if (command === "git" && args.join(" ") === "rev-parse --show-toplevel") {
        return { code: 0, stdout: `${tmpDir}\n`, stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    }) as any;

    let settingsVisits = 0;
    let topLevelOptions: string[] = [];
    let scopeOptions: string[] = [];
    const selectTitles: string[] = [];
    ctx.ui.select = mock(async (title: string, options: string[]) => {
      selectTitles.push(title);
      if (title === "Supipowers Settings") {
        settingsVisits += 1;
        topLevelOptions = [...options];
        return settingsVisits === 1 ? options[0]! : "Done";
      }
      if (title === "Config scope") {
        scopeOptions = [...options];
        return options[1]!;
      }
      return null;
    });

    await runConfigMenu(platform, ctx, {
      inspectConfig,
      updateConfig: mock(updateConfig),
      setupGates: mock(),
    });

    expect(topLevelOptions[0]).toContain("Config scope: monorepo repository");
    expect(scopeOptions).toEqual([
      "Global — ~/.omp/supipowers/config.json",
      "Monorepo repository — .omp/supipowers/config.json",
      "Cancel",
    ]);
    expect(selectTitles).not.toContain("Workspace config target");
    expect(fs.existsSync(workspaceConfigPath(localPaths, tmpDir, "packages/pkg-a"))).toBe(false);
  });

  test("buildConfigScopeView preserves default effective config when no files exist", () => {
    const view = createScopeView(platform, "root", tmpDir);
    expect(view.inspection.effectiveConfig).toEqual(DEFAULT_CONFIG);
  });
});
