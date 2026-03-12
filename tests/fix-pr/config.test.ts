import { describe, test, expect } from "vitest";
import { loadFixPrConfig, saveFixPrConfig, DEFAULT_FIX_PR_CONFIG } from "../../src/fix-pr/config.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("loadFixPrConfig", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-fpr-config-"));
    return tmpDir;
  }

  function cleanup() {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  test("returns null when config file does not exist", () => {
    setup();
    const result = loadFixPrConfig(tmpDir);
    expect(result).toBeNull();
    cleanup();
  });

  test("loads config from fix-pr.json", () => {
    setup();
    const configDir = path.join(tmpDir, ".omp", "supipowers");
    fs.mkdirSync(configDir, { recursive: true });
    const config = { ...DEFAULT_FIX_PR_CONFIG };
    fs.writeFileSync(path.join(configDir, "fix-pr.json"), JSON.stringify(config));
    const result = loadFixPrConfig(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.loop.delaySeconds).toBe(180);
    cleanup();
  });

  test("returns null for invalid JSON", () => {
    setup();
    const configDir = path.join(tmpDir, ".omp", "supipowers");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "fix-pr.json"), "not json");
    const result = loadFixPrConfig(tmpDir);
    expect(result).toBeNull();
    cleanup();
  });
});

describe("saveFixPrConfig", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-fpr-config-"));
    return tmpDir;
  }

  function cleanup() {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  test("writes config to fix-pr.json", () => {
    setup();
    saveFixPrConfig(tmpDir, DEFAULT_FIX_PR_CONFIG);
    const configPath = path.join(tmpDir, ".omp", "supipowers", "fix-pr.json");
    expect(fs.existsSync(configPath)).toBe(true);
    const loaded = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(loaded.loop.delaySeconds).toBe(180);
    cleanup();
  });

  test("creates directories if they don't exist", () => {
    setup();
    saveFixPrConfig(tmpDir, DEFAULT_FIX_PR_CONFIG);
    const configDir = path.join(tmpDir, ".omp", "supipowers");
    expect(fs.existsSync(configDir)).toBe(true);
    cleanup();
  });
});

describe("DEFAULT_FIX_PR_CONFIG", () => {
  test("has sensible defaults", () => {
    expect(DEFAULT_FIX_PR_CONFIG.reviewer.type).toBe("none");
    expect(DEFAULT_FIX_PR_CONFIG.commentPolicy).toBe("answer-selective");
    expect(DEFAULT_FIX_PR_CONFIG.loop.delaySeconds).toBe(180);
    expect(DEFAULT_FIX_PR_CONFIG.loop.maxIterations).toBe(3);
    expect(DEFAULT_FIX_PR_CONFIG.models.orchestrator.tier).toBe("high");
    expect(DEFAULT_FIX_PR_CONFIG.models.fixer.tier).toBe("low");
  });
});
