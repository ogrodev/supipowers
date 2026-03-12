import { describe, test, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadE2eQaConfig, saveE2eQaConfig, DEFAULT_E2E_QA_CONFIG } from "../../src/qa/config.js";

describe("E2E QA config", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-config-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("DEFAULT_E2E_QA_CONFIG has sensible defaults", () => {
    expect(DEFAULT_E2E_QA_CONFIG.app.type).toBe("generic");
    expect(DEFAULT_E2E_QA_CONFIG.playwright.browser).toBe("chromium");
    expect(DEFAULT_E2E_QA_CONFIG.playwright.headless).toBe(true);
    expect(DEFAULT_E2E_QA_CONFIG.playwright.timeout).toBe(30000);
    expect(DEFAULT_E2E_QA_CONFIG.execution.maxRetries).toBe(2);
    expect(DEFAULT_E2E_QA_CONFIG.execution.maxFlows).toBe(20);
  });

  test("loadE2eQaConfig returns null when no config exists", () => {
    expect(loadE2eQaConfig(tmpDir)).toBeNull();
  });

  test("saveE2eQaConfig creates config file and loadE2eQaConfig reads it", () => {
    const config = { ...DEFAULT_E2E_QA_CONFIG };
    config.app = { ...config.app, type: "nextjs-app" as const, port: 3000, baseUrl: "http://localhost:3000", devCommand: "npm run dev" };

    saveE2eQaConfig(tmpDir, config);

    const loaded = loadE2eQaConfig(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.app.type).toBe("nextjs-app");
    expect(loaded!.app.port).toBe(3000);
  });

  test("saveE2eQaConfig creates parent directories if missing", () => {
    saveE2eQaConfig(tmpDir, DEFAULT_E2E_QA_CONFIG);
    const configPath = path.join(tmpDir, ".omp", "supipowers", "e2e-qa.json");
    expect(fs.existsSync(configPath)).toBe(true);
  });

  test("loadE2eQaConfig returns null for invalid JSON", () => {
    const configDir = path.join(tmpDir, ".omp", "supipowers");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "e2e-qa.json"), "not json");
    expect(loadE2eQaConfig(tmpDir)).toBeNull();
  });

  test("saveE2eQaConfig overwrites existing config", () => {
    saveE2eQaConfig(tmpDir, DEFAULT_E2E_QA_CONFIG);

    const updated = { ...DEFAULT_E2E_QA_CONFIG, execution: { maxRetries: 5, maxFlows: 10 } };
    saveE2eQaConfig(tmpDir, updated);

    const loaded = loadE2eQaConfig(tmpDir);
    expect(loaded!.execution.maxRetries).toBe(5);
    expect(loaded!.execution.maxFlows).toBe(10);
  });
});
