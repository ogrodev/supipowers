// tests/config/loader.test.ts
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadConfig, saveConfig, updateConfig, deepMerge } from "../../src/config/loader.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";

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
    const config = loadConfig(tmpDir);
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  test("merges project config over defaults", () => {
    const configDir = path.join(tmpDir, ".omp", "supipowers");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ orchestration: { maxParallelAgents: 5 } })
    );
    const config = loadConfig(tmpDir);
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
    saveConfig(tmpDir, DEFAULT_CONFIG);
    const filePath = path.join(tmpDir, ".omp", "supipowers", "config.json");
    expect(fs.existsSync(filePath)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(saved.version).toBe("1.0.0");
  });

  test("updateConfig deep-merges and persists", () => {
    const updated = updateConfig(tmpDir, { orchestration: { maxParallelAgents: 7 } });
    expect(updated.orchestration.maxParallelAgents).toBe(7);
    expect(updated.orchestration.maxFixRetries).toBe(2);
    // Verify it was persisted
    const reloaded = loadConfig(tmpDir);
    expect(reloaded.orchestration.maxParallelAgents).toBe(7);
  });
});
