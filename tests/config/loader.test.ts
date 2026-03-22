// tests/config/loader.test.ts
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadConfig, saveConfig, updateConfig, deepMerge } from "../../src/config/loader.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { createPaths } from "../../src/platform/types.js";

const paths = createPaths(".omp");

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
    expect(deepMerge(target, source as any)).toEqual({ a: null });
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

  test("merges project config over defaults", () => {
    const configDir = path.join(tmpDir, ".omp", "supipowers");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ orchestration: { maxParallelAgents: 5 } })
    );
    const config = loadConfig(paths, tmpDir);
    expect(config.orchestration.maxParallelAgents).toBe(5);
    expect(config.orchestration.maxFixRetries).toBe(2); // inherited from default
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

  test("updateConfig deep-merges and persists", () => {
    const updated = updateConfig(paths, tmpDir, { orchestration: { maxParallelAgents: 7 } });
    expect(updated.orchestration.maxParallelAgents).toBe(7);
    expect(updated.orchestration.maxFixRetries).toBe(2);
    // Verify it was persisted
    const reloaded = loadConfig(paths, tmpDir);
    expect(reloaded.orchestration.maxParallelAgents).toBe(7);
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
    expect(config.contextMode.enabled).toBe(true); // untouched fields preserved
  });
});