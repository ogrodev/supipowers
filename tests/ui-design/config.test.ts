import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_UI_DESIGN_CONFIG,
  loadUiDesignConfig,
  saveUiDesignConfig,
} from "../../src/ui-design/config.js";
import { createPaths } from "../../src/platform/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-ui-design-config-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("ui-design config", () => {
  test("DEFAULT_UI_DESIGN_CONFIG shape", () => {
    expect(DEFAULT_UI_DESIGN_CONFIG).toEqual({ backend: "local-html" });
  });

  test("loadUiDesignConfig returns null when file missing", () => {
    const paths = createPaths(".omp");
    expect(loadUiDesignConfig(paths, tmpDir)).toBeNull();
  });

  test("loadUiDesignConfig parses valid config", () => {
    const paths = createPaths(".omp");
    const configPath = paths.project(tmpDir, "ui-design.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ backend: "local-html", port: 4321 }));

    const cfg = loadUiDesignConfig(paths, tmpDir);
    expect(cfg).toEqual({ backend: "local-html", port: 4321 });
  });

  test("loadUiDesignConfig returns null for malformed JSON", () => {
    const paths = createPaths(".omp");
    const configPath = paths.project(tmpDir, "ui-design.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "{not valid json");

    expect(loadUiDesignConfig(paths, tmpDir)).toBeNull();
  });

  test("loadUiDesignConfig returns null when backend missing", () => {
    const paths = createPaths(".omp");
    const configPath = paths.project(tmpDir, "ui-design.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ port: 4321 }));

    expect(loadUiDesignConfig(paths, tmpDir)).toBeNull();
  });

  test("loadUiDesignConfig returns null when backend is unknown", () => {
    const paths = createPaths(".omp");
    const configPath = paths.project(tmpDir, "ui-design.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ backend: "figma-mcp" }));

    expect(loadUiDesignConfig(paths, tmpDir)).toBeNull();
  });

  test("saveUiDesignConfig creates parent directories and writes pretty JSON", () => {
    const paths = createPaths(".omp");
    saveUiDesignConfig(paths, tmpDir, { backend: "local-html", port: 5555 });

    const configPath = paths.project(tmpDir, "ui-design.json");
    expect(fs.existsSync(configPath)).toBe(true);
    const content = fs.readFileSync(configPath, "utf-8");
    expect(content).toContain("\n");
    expect(JSON.parse(content)).toEqual({ backend: "local-html", port: 5555 });
  });
});
