import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createPaths, type Platform } from "../../src/platform/types.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type { InspectionLoadResult } from "../../src/config/schema.js";
import {
  interactivelySaveGateSetup,
  setupGates,
} from "../../src/quality/setup.js";

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

function createPlatform(localPaths: ReturnType<typeof createPaths>, activeTools: string[] = []): Platform {
  return {
    name: "omp",
    registerCommand: mock(),
    getCommands: mock(() => []),
    on: mock(),
    exec: mock(),
    sendMessage: mock(),
    sendUserMessage: mock(),
    getActiveTools: mock(() => activeTools),
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

function createInspection(): InspectionLoadResult {
  return {
    mergedConfig: DEFAULT_CONFIG as unknown as Record<string, unknown>,
    effectiveConfig: DEFAULT_CONFIG,
    parseErrors: [],
    validationErrors: [],
  };
}

function writePackageJson(dir: string, data: unknown): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(data, null, 2));
}

function writeProjectConfig(localPaths: ReturnType<typeof createPaths>, cwd: string, data: unknown): void {
  const filePath = localPaths.project(cwd, "config.json");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function writeGlobalConfig(localPaths: ReturnType<typeof createPaths>, data: unknown): void {
  const filePath = localPaths.global("config.json");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function readProjectConfig(localPaths: ReturnType<typeof createPaths>, cwd: string): unknown {
  return JSON.parse(fs.readFileSync(localPaths.project(cwd, "config.json"), "utf-8"));
}

function readGlobalConfig(localPaths: ReturnType<typeof createPaths>): unknown {
  return JSON.parse(fs.readFileSync(localPaths.global("config.json"), "utf-8"));
}

describe("setupGates", () => {
  let tmpDir: string;
  let localPaths: ReturnType<typeof createPaths>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-setup-test-"));
    localPaths = createTestPaths(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns deterministic suggestions from package scripts", async () => {
    writePackageJson(tmpDir, { scripts: { test: "bun test" } });

    const result = await setupGates(
      createPlatform(localPaths),
      tmpDir,
      createInspection(),
      { mode: "deterministic" },
    );

    expect(result.status).toBe("proposed");
    if (result.status !== "proposed") {
      throw new Error("Expected a proposed setup result");
    }
    expect(result.proposal).toMatchObject({
      gates: { "test-suite": { enabled: true, command: "bun test" } },
    });
  });


  test("keeps workspace-only commands as proposal notes instead of auto-configuring them", async () => {
    writePackageJson(tmpDir, {
      name: "repo-root",
      private: true,
      workspaces: ["packages/*"],
      scripts: { test: "bun test" },
      packageManager: "bun@1.3.10",
    });
    writePackageJson(path.join(tmpDir, "packages", "web"), {
      name: "web",
      scripts: { typecheck: "tsc --noEmit", test: "bun test" },
    });
    writePackageJson(path.join(tmpDir, "packages", "api"), {
      name: "api",
      scripts: { checkTypes: "tsc --noEmit", test: "bun test" },
    });

    const result = await setupGates(
      createPlatform(localPaths),
      tmpDir,
      createInspection(),
      { mode: "deterministic" },
    );

    expect(result.status).toBe("proposed");
    if (result.status !== "proposed") {
      throw new Error("Expected a proposed setup result");
    }
    expect(result.proposal.gates["typecheck"]).toBeUndefined();
    expect(result.proposal.notes).toEqual(
      expect.arrayContaining([expect.stringContaining("workspace targets only")]),
    );
  });

  test("auto-configures commands shared across all targets even when script names differ", async () => {
    writePackageJson(tmpDir, {
      name: "repo-root",
      private: true,
      workspaces: ["packages/*"],
      scripts: { checkTypes: "tsc --noEmit", test: "bun test" },
      packageManager: "bun@1.3.10",
    });
    writePackageJson(path.join(tmpDir, "packages", "web"), {
      name: "web",
      scripts: { typecheck: "tsc --noEmit", test: "bun test" },
    });
    writePackageJson(path.join(tmpDir, "packages", "api"), {
      name: "api",
      scripts: { types: "tsc --noEmit", test: "bun test" },
    });

    const result = await setupGates(
      createPlatform(localPaths),
      tmpDir,
      createInspection(),
      { mode: "deterministic" },
    );

    expect(result.status).toBe("proposed");
    if (result.status !== "proposed") {
      throw new Error("Expected a proposed setup result");
    }
    expect(result.proposal.gates["typecheck"]).toEqual({ enabled: true, command: "tsc --noEmit" });
    expect(result.proposal.notes).toEqual(
      expect.arrayContaining([expect.stringContaining("shared across all targets")]),
    );
  });

  test("passes per-target package scripts to AI-assisted setup in monorepos", async () => {
    writePackageJson(tmpDir, {
      name: "repo-root",
      private: true,
      workspaces: ["packages/*"],
      scripts: { test: "bun test" },
      packageManager: "bun@1.3.10",
    });
    writePackageJson(path.join(tmpDir, "packages", "web"), {
      name: "web",
      scripts: { typecheck: "tsc --noEmit", test: "bun test" },
    });
    writePackageJson(path.join(tmpDir, "packages", "api"), {
      name: "api",
      scripts: { typecheck: "tsc --noEmit", test: "bun test" },
    });

    let receivedFacts: any = null;
    const result = await setupGates(
      createPlatform(localPaths),
      tmpDir,
      createInspection(),
      { mode: "ai-assisted" },
      {
        suggestWithAi: mock(async ({ projectFacts }) => {
          receivedFacts = projectFacts;
          return { typecheck: { enabled: true, command: "tsc --noEmit" } };
        }),
      },
    );

    expect(result.status).toBe("proposed");
    expect(receivedFacts).toMatchObject({
      cwd: tmpDir,
      packageScripts: { test: "bun test" },
      targets: [
        { name: "repo-root", kind: "root", relativeDir: ".", packageScripts: { test: "bun test" } },
        { name: "api", kind: "workspace", relativeDir: "packages/api", packageScripts: { typecheck: "tsc --noEmit", test: "bun test" } },
        { name: "web", kind: "workspace", relativeDir: "packages/web", packageScripts: { typecheck: "tsc --noEmit", test: "bun test" } },
      ],
    });
  });
});

describe("interactivelySaveGateSetup", () => {
  let tmpDir: string;
  let localPaths: ReturnType<typeof createPaths>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-setup-test-"));
    localPaths = createTestPaths(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("cancel leaves project config unchanged", async () => {
    writeProjectConfig(localPaths, tmpDir, { lsp: { setupGuide: false } });
    const ctx = {
      cwd: tmpDir,
      hasUI: true,
      ui: {
        select: mock(async () => "Cancel"),
        notify: mock(),
        input: mock(async () => null),
      },
    } as any;

    await interactivelySaveGateSetup(ctx, localPaths, tmpDir, {
      gates: { "test-suite": { enabled: true, command: "bun test" } },
    });

    expect(readProjectConfig(localPaths, tmpDir)).toEqual({ lsp: { setupGuide: false } });
  });

  test("save to project replaces quality.gates but preserves unrelated project fields", async () => {
    writeProjectConfig(localPaths, tmpDir, {
      lsp: { setupGuide: false },
      quality: { gates: { "ai-review": { enabled: true, depth: "deep" } } },
    });
    const select = mock(async () => {
      const choices = [
        "Accept",
        "Project (.omp/supipowers/config.json)",
      ];
      return choices[select.mock.calls.length - 1] ?? null;
    });
    const ctx = {
      cwd: tmpDir,
      hasUI: true,
      ui: {
        select,
        notify: mock(),
        input: mock(async () => null),
      },
    } as any;

    await interactivelySaveGateSetup(ctx, localPaths, tmpDir, {
      gates: { "test-suite": { enabled: true, command: "bun test" } },
    });

    expect(readProjectConfig(localPaths, tmpDir)).toEqual({
      lsp: { setupGuide: false },
      quality: { gates: { "test-suite": { enabled: true, command: "bun test" } } },
    });
  });

  test("save to global writes only the selected scope", async () => {
    writeGlobalConfig(localPaths, { lsp: { setupGuide: false } });
    const select = mock(async () => {
      const choices = [
        "Accept",
        "Global (~/.omp/supipowers/config.json)",
      ];
      return choices[select.mock.calls.length - 1] ?? null;
    });
    const ctx = {
      cwd: tmpDir,
      hasUI: true,
      ui: {
        select,
        notify: mock(),
        input: mock(async () => null),
      },
    } as any;

    await interactivelySaveGateSetup(ctx, localPaths, tmpDir, {
      gates: { "lsp-diagnostics": { enabled: true } },
    });

    expect(readGlobalConfig(localPaths)).toEqual({
      lsp: { setupGuide: false },
      quality: { gates: { "lsp-diagnostics": { enabled: true } } },
    });
    expect(fs.existsSync(localPaths.project(tmpDir, "config.json"))).toBe(false);
  });

  test("revise updates proposal before save", async () => {
    const select = mock(async () => {
      const choices = [
        "Revise",
        "Accept",
        "Project (.omp/supipowers/config.json)",
      ];
      return choices[select.mock.calls.length - 1] ?? null;
    });
    const ctx = {
      cwd: tmpDir,
      hasUI: true,
      ui: {
        select,
        notify: mock(),
        input: mock(async () => JSON.stringify({ "lsp-diagnostics": { enabled: true } }, null, 2)),
      },
    } as any;

    await interactivelySaveGateSetup(ctx, localPaths, tmpDir, {
      gates: { "test-suite": { enabled: true, command: "bun test" } },
    });

    expect(readProjectConfig(localPaths, tmpDir)).toEqual({
      quality: { gates: { "lsp-diagnostics": { enabled: true } } },
    });
  });
});
