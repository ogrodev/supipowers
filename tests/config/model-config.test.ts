
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  loadModelConfig,
  saveModelAssignment,
  getAssignmentSource,
  DEFAULT_MODEL_CONFIG,
} from "../../src/config/model-config.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { createPaths } from "../../src/platform/types.js";

const paths = createPaths(".omp");

describe("loadModelConfig", () => {
  let tmpDir: string;
  // Isolated paths: redirect global scope to tmpDir so real ~/.omp/supipowers/model.json is never read
  let localPaths: ReturnType<typeof createPaths>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-model-test-"));
    localPaths = {
      dotDir: ".omp",
      dotDirDisplay: ".omp",
      project: (cwd: string, ...segments: string[]) => path.join(cwd, ".omp", "supipowers", ...segments),
      global: (...segments: string[]) => path.join(tmpDir, "global-config", "supipowers", ...segments),
      agent: (...segments: string[]) => path.join(tmpDir, "agent", ...segments),
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns empty config when no files exist", () => {
    const config = loadModelConfig(localPaths, tmpDir);
    expect(config).toEqual(DEFAULT_MODEL_CONFIG);
    expect(config.default).toBeNull();
    expect(config.actions).toEqual({});
  });

  test("loads project-level model.json", () => {
    const configDir = path.join(tmpDir, ".omp", "supipowers");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "model.json"),
      JSON.stringify({
        version: "1.0.0",
        default: { model: "claude-opus-4-6", thinkingLevel: null },
        actions: { plan: { model: "claude-opus-4-6", thinkingLevel: "high" } },
      }),
    );
    const config = loadModelConfig(localPaths, tmpDir);
    expect(config.default?.model).toBe("claude-opus-4-6");
    expect(config.actions.plan.model).toBe("claude-opus-4-6");
    expect(config.actions.plan.thinkingLevel).toBe("high");
  });
});

describe("saveModelAssignment", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-model-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("saves action assignment to project scope", () => {
    saveModelAssignment(paths, tmpDir, "project", "plan", {
      model: "claude-opus-4-6",
      thinkingLevel: "high",
    });
    const filePath = path.join(tmpDir, ".omp", "supipowers", "model.json");
    expect(fs.existsSync(filePath)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(saved.actions.plan.model).toBe("claude-opus-4-6");
  });

  test("saves default assignment (actionId null)", () => {
    saveModelAssignment(paths, tmpDir, "project", null, {
      model: "claude-sonnet-4-6",
      thinkingLevel: null,
    });
    const filePath = path.join(tmpDir, ".omp", "supipowers", "model.json");
    const saved = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(saved.default.model).toBe("claude-sonnet-4-6");
  });

  test("clears assignment (null value)", () => {
    saveModelAssignment(paths, tmpDir, "project", "plan", {
      model: "claude-opus-4-6",
      thinkingLevel: null,
    });
    saveModelAssignment(paths, tmpDir, "project", "plan", null);
    const filePath = path.join(tmpDir, ".omp", "supipowers", "model.json");
    const saved = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(saved.actions.plan).toBeUndefined();
  });

  test("preserves existing assignments when adding new one", () => {
    saveModelAssignment(paths, tmpDir, "project", "plan", {
      model: "claude-opus-4-6",
      thinkingLevel: null,
    });
    saveModelAssignment(paths, tmpDir, "project", "review", {
      model: "claude-sonnet-4-6",
      thinkingLevel: null,
    });
    const filePath = path.join(tmpDir, ".omp", "supipowers", "model.json");
    const saved = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(saved.actions.plan.model).toBe("claude-opus-4-6");
    expect(saved.actions.review.model).toBe("claude-sonnet-4-6");
  });
});

describe("getAssignmentSource", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-model-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns 'action-project' when action is in project file", () => {
    saveModelAssignment(paths, tmpDir, "project", "plan", {
      model: "claude-opus-4-6",
      thinkingLevel: null,
    });
    const source = getAssignmentSource(paths, tmpDir, "plan");
    expect(source).toBe("action-project");
  });

  test("returns 'main' when no config exists", () => {
    const source = getAssignmentSource(paths, tmpDir, "plan");
    expect(source).toBe("main");
  });

  test("returns 'default-project' when only default is set in project", () => {
    saveModelAssignment(paths, tmpDir, "project", null, {
      model: "claude-sonnet-4-6",
      thinkingLevel: null,
    });
    const source = getAssignmentSource(paths, tmpDir, "review");
    expect(source).toBe("default-project");
  });
});

