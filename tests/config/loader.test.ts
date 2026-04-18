import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  deepMerge,
  inspectConfig,
  inspectQualityGateRecovery,
  loadConfig,
  removeQualityGatesConfig,
  saveConfig,
  updateConfig,
  writeQualityGatesConfig,
} from "../../src/config/loader.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { createPaths } from "../../src/platform/types.js";
import type { ReviewReport } from "../../src/types.js";

const paths = createPaths(".omp");

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

function writeJsonFile(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data));
}

function writeProjectConfig(
  localPaths: ReturnType<typeof createPaths>,
  cwd: string,
  data: unknown,
): void {
  writeJsonFile(localPaths.project(cwd, "config.json"), data);
}

function writeRawProjectConfig(
  localPaths: ReturnType<typeof createPaths>,
  cwd: string,
  raw: string,
): void {
  const filePath = localPaths.project(cwd, "config.json");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, raw);
}

function writeGlobalConfig(
  localPaths: ReturnType<typeof createPaths>,
  data: unknown,
): void {
  writeJsonFile(localPaths.global("config.json"), data);
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

function writeLegacyWorkspaceConfig(
  localPaths: ReturnType<typeof createPaths>,
  repoRoot: string,
  workspaceRelativeDir: string,
  data: unknown,
): void {
  writeJsonFile(workspaceConfigPath(localPaths, repoRoot, workspaceRelativeDir), data);
}

function readProjectConfig(localPaths: ReturnType<typeof createPaths>, cwd: string): unknown {
  return JSON.parse(fs.readFileSync(localPaths.project(cwd, "config.json"), "utf-8"));
}

function readGlobalConfig(localPaths: ReturnType<typeof createPaths>): unknown {
  return JSON.parse(fs.readFileSync(localPaths.global("config.json"), "utf-8"));
}

describe("deepMerge", () => {
  test("merges nested objects", () => {
    const target = { a: { b: 1, c: 2 }, d: 3 };
    const source = { a: { b: 10 } };
    const result = deepMerge(target, source);
    expect(result).toEqual({ a: { b: 10, c: 2 }, d: 3 });
  });

  test("source overrides scalars", () => {
    const target = { a: 1 };
    const source = { a: 2 };
    expect(deepMerge(target, source)).toEqual({ a: 2 });
  });

  test("handles null values in source", () => {
    const target = { a: { b: 1 } };
    const source = { a: null };
    expect(deepMerge(target, source as any)).toEqual({ a: null } as any);
  });
});

describe("loadConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns defaults when no config files exist", () => {
    const config = loadConfig(paths, tmpDir);
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  test("DEFAULT_CONFIG uses empty quality gate defaults", () => {
    expect(DEFAULT_CONFIG).toMatchObject({
      quality: { gates: {} },
    });
    expect("defaultProfile" in DEFAULT_CONFIG).toBe(false);
  });

  test("merges project config over defaults", () => {
    const configDir = path.join(tmpDir, ".omp", "supipowers");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ contextMode: { compressionThreshold: 8192 } }),
    );
    const config = loadConfig(paths, tmpDir);
    expect(config.contextMode.compressionThreshold).toBe(8192);
    expect(config.contextMode.enabled).toBe(true);
  });
});

describe("strict and inspection config loading", () => {
  let tmpDir: string;
  let localPaths: ReturnType<typeof createPaths>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-config-test-"));
    localPaths = createTestPaths(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("strict load rejects invalid quality gate config", () => {
    writeProjectConfig(localPaths, tmpDir, {
      quality: { gates: { "lsp-diagnostics": { enabled: "not-a-boolean" } } },
    });

    expect(() => loadConfig(localPaths, tmpDir)).toThrow(/quality\.gates/);
  });

  test("strict load rejects release.tagFormat without ${version}", () => {
    writeProjectConfig(localPaths, tmpDir, {
      release: { channels: ["github"], tagFormat: "fixed-tag" },
    });

    expect(() => loadConfig(localPaths, tmpDir)).toThrow(/release\.tagFormat/);
  });

  test("migrates legacy profile-era config keys before validation", () => {
    writeProjectConfig(localPaths, tmpDir, {
      version: "1.0.0",
      defaultProfile: "thorough",
      orchestration: {
        maxParallelAgents: 3,
        maxFixRetries: 2,
        maxNestingDepth: 2,
        modelPreference: "auto",
        taskTimeout: 600000,
      },
      qa: { framework: null, command: null, e2e: false },
      release: { channels: ["github", "npm"], pipeline: "npm" },
    });

    const inspection = inspectConfig(localPaths, tmpDir);
    expect(inspection.validationErrors).toHaveLength(0);
    expect(inspection.effectiveConfig).not.toBeNull();

    expect(loadConfig(localPaths, tmpDir)).toMatchObject({
      quality: {
        gates: {
          "lsp-diagnostics": { enabled: true },
        },
      },
      qa: { framework: null, e2e: false },
      release: { channels: ["github"], tagFormat: "v${version}" },
    });

    const merged = inspection.mergedConfig as Record<string, unknown>;
    expect("defaultProfile" in merged).toBe(false);
    expect("orchestration" in merged).toBe(false);
    expect("command" in (merged.qa as Record<string, unknown>)).toBe(false);
    expect("pipeline" in (merged.release as Record<string, unknown>)).toBe(false);
  });

  test("inspection load reports malformed JSON without hiding the file", () => {
    writeRawProjectConfig(localPaths, tmpDir, "{ invalid json");

    const result = inspectConfig(localPaths, tmpDir);

    expect(result.parseErrors).toHaveLength(1);
    expect(result.effectiveConfig).toBeNull();
  });

  test("project quality.gates replaces inherited global gates", () => {
    writeGlobalConfig(localPaths, {
      quality: { gates: { lint: { enabled: true, command: "eslint ." } } },
    });
    writeProjectConfig(localPaths, tmpDir, {
      quality: { gates: { "test-suite": { enabled: true, command: "npm test" } } },
    });

    expect(loadConfig(localPaths, tmpDir).quality.gates).toEqual({
      "test-suite": { enabled: true, command: "npm test" },
    });
  });

  test("loads shared repository config from a workspace directory and ignores legacy workspace files", () => {
    writeGlobalConfig(localPaths, {
      lsp: { setupGuide: false },
    });
    writeProjectConfig(localPaths, tmpDir, {
      contextMode: { compressionThreshold: 8192 },
    });
    writeLegacyWorkspaceConfig(localPaths, tmpDir, "packages/pkg-a", {
      contextMode: { compressionThreshold: 16384 },
      qa: { e2e: true },
    });
    const workspaceDir = path.join(tmpDir, "packages", "pkg-a");
    fs.mkdirSync(workspaceDir, { recursive: true });

    const config = loadConfig(localPaths, workspaceDir, {
      repoRoot: tmpDir,
    });

    expect(config.lsp.setupGuide).toBe(false);
    expect(config.contextMode.compressionThreshold).toBe(8192);
    expect(config.qa.e2e).toBe(false);
  });
});

describe("quality gate recovery helpers", () => {
  let tmpDir: string;
  let localPaths: ReturnType<typeof createPaths>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-loader-recovery-test-"));
    localPaths = createTestPaths(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("detects invalid quality.gates per scope without treating valid scopes as broken", () => {
    writeGlobalConfig(localPaths, {
      quality: { gates: { "lsp-diagnostics": { enabled: "not-a-boolean" } } },
    });
    writeProjectConfig(localPaths, tmpDir, {
      lsp: { setupGuide: false },
    });

    const result = inspectQualityGateRecovery(localPaths, tmpDir);
    const globalScope = result.scopes.find((scope) => scope.scope === "global");
    const rootScope = result.scopes.find((scope) => scope.scope === "root");

    expect(globalScope?.recoverableInvalidQualityGates).toBe(true);
    expect(globalScope?.qualityGateValidationErrors.length).toBeGreaterThan(0);
    expect(rootScope?.recoverableInvalidQualityGates).toBe(false);
    expect(rootScope?.validationErrors).toHaveLength(0);
  });

  test("recovery inspection stays at global and repository scopes from workspace directories", () => {
    writeLegacyWorkspaceConfig(localPaths, tmpDir, "packages/pkg-a", {
      quality: { gates: { "test-suite": { enabled: true, command: 42 } } },
    });
    const workspaceDir = path.join(tmpDir, "packages", "pkg-a");
    fs.mkdirSync(workspaceDir, { recursive: true });

    const result = inspectQualityGateRecovery(localPaths, workspaceDir, {
      repoRoot: tmpDir,
    });

    expect(result.scopes.map((scope) => scope.scope)).toEqual(["global", "root"]);
    expect(result.scopes.some((scope) => scope.recoverableInvalidQualityGates)).toBe(false);
  });

  test("removeQualityGatesConfig removes only quality.gates and preserves unrelated keys", () => {
    writeProjectConfig(localPaths, tmpDir, {
      lsp: { setupGuide: false },
      quality: { gates: { "lsp-diagnostics": { enabled: "not-a-boolean" } } },
    });

    expect(removeQualityGatesConfig(localPaths, tmpDir, "root")).toBe(true);
    expect(readProjectConfig(localPaths, tmpDir)).toEqual({
      lsp: { setupGuide: false },
    });
  });

  test("removeQualityGatesConfig drops empty quality object after cleanup", () => {
    writeGlobalConfig(localPaths, {
      quality: { gates: { "test-suite": { enabled: true, command: 42 } } },
    });

    expect(removeQualityGatesConfig(localPaths, tmpDir, "global")).toBe(true);
    expect(readGlobalConfig(localPaths)).toEqual({});
  });

  test("writeQualityGatesConfig writes to the selected scope and preserves sibling keys", () => {
    writeGlobalConfig(localPaths, {
      lsp: { setupGuide: false },
    });

    writeQualityGatesConfig(localPaths, tmpDir, "global", {
      "test-suite": { enabled: true, command: "bun test" },
    });

    expect(readGlobalConfig(localPaths)).toEqual({
      lsp: { setupGuide: false },
      quality: { gates: { "test-suite": { enabled: true, command: "bun test" } } },
    });
  });
});

describe("quality gate types", () => {
  test("ReviewReport stores aggregate statuses instead of profile boolean", () => {
    const report: ReviewReport = {
      timestamp: "2026-04-10T00:00:00.000Z",
      selectedGates: ["lsp-diagnostics"],
      gates: [],
      summary: { passed: 1, failed: 0, skipped: 0, blocked: 0 },
      overallStatus: "passed",
    };
    expect(report.overallStatus).toBe("passed");
  });
});

describe("saveConfig / updateConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("saveConfig creates dirs and writes file", () => {
    saveConfig(paths, tmpDir, DEFAULT_CONFIG);
    const filePath = path.join(tmpDir, ".omp", "supipowers", "config.json");
    expect(fs.existsSync(filePath)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(saved.version).toBe("1.0.0");
  });

  test("saveConfig rejects invalid release.tagFormat", () => {
    expect(() =>
      saveConfig(paths, tmpDir, {
        ...DEFAULT_CONFIG,
        release: {
          ...DEFAULT_CONFIG.release,
          tagFormat: "fixed-tag",
        },
      }),
    ).toThrow(/release\.tagFormat/);
  });

  test("updateConfig deep-merges and persists", () => {
    const updated = updateConfig(paths, tmpDir, { contextMode: { compressionThreshold: 8192 } });
    expect(updated.contextMode.compressionThreshold).toBe(8192);
    expect(updated.contextMode.enabled).toBe(true);

    const reloaded = loadConfig(paths, tmpDir);
    expect(reloaded.contextMode.compressionThreshold).toBe(8192);
  });

  test("updateConfig writes repository scope even when invoked from a workspace directory", () => {
    const localPaths = createTestPaths(tmpDir);
    writeGlobalConfig(localPaths, {
      lsp: { setupGuide: false },
    });
    writeProjectConfig(localPaths, tmpDir, {
      contextMode: { compressionThreshold: 8192 },
    });
    const workspaceDir = path.join(tmpDir, "packages", "pkg-a");
    fs.mkdirSync(workspaceDir, { recursive: true });

    const updated = updateConfig(
      localPaths,
      workspaceDir,
      { qa: { e2e: true } },
      { repoRoot: tmpDir, scope: "root" },
    );

    expect(readProjectConfig(localPaths, tmpDir)).toEqual({
      contextMode: { compressionThreshold: 8192 },
      qa: { e2e: true },
    });
    expect(fs.existsSync(workspaceConfigPath(localPaths, tmpDir, "packages/pkg-a"))).toBe(false);
    expect(updated.lsp.setupGuide).toBe(false);
    expect(updated.contextMode.compressionThreshold).toBe(8192);
    expect(updated.qa.e2e).toBe(true);
  });

  test("updateConfig rejects invalid release.tagFormat", () => {
    expect(() => updateConfig(paths, tmpDir, { release: { tagFormat: "fixed-tag" } })).toThrow(
      /release\.tagFormat/,
    );
  });
});

describe("contextMode config", () => {
  test("DEFAULT_CONFIG includes contextMode with all fields", () => {
    const config = DEFAULT_CONFIG;
    expect(config.contextMode).toBeDefined();
    expect(config.contextMode.enabled).toBe(true);
    expect(config.contextMode.compressionThreshold).toBe(4096);
    expect(config.contextMode.blockHttpCommands).toBe(true);
    expect(config.contextMode.routingInstructions).toBe(true);
    expect(config.contextMode.eventTracking).toBe(true);
    expect(config.contextMode.compaction).toBe(true);
    expect(config.contextMode.llmSummarization).toBe(false);
    expect(config.contextMode.llmThreshold).toBe(16384);
  });

  test("deepMerge applies contextMode overrides", () => {
    const config = deepMerge(DEFAULT_CONFIG, {
      contextMode: { compressionThreshold: 8192 },
    });
    expect(config.contextMode.compressionThreshold).toBe(8192);
    expect(config.contextMode.enabled).toBe(true);
  });
});
