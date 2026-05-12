import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { validateConfig } from "../../src/config/schema.js";
import {
  normalizeMempalaceWing,
  resolveDefaultWing,
  resolveMempalaceConfig,
} from "../../src/mempalace/config.js";
import { createPaths } from "../../src/platform/types.js";
import { getProjectStateDir } from "../../src/workspace/state-paths.js";

describe("mempalace config defaults", () => {
  test("matches the approved native MemPalace defaults", () => {
    expect(DEFAULT_CONFIG.mempalace).toEqual({
      enabled: true,
      packageVersion: "3.3.4",
      managedVenvPath: "~/.omp/supipowers/mempalace-venv",
      palacePath: "~/.mempalace/palace",
      defaultWingStrategy: "repo-name",
      explicitWing: null,
      defaultAgentName: "omp",
      autoSetup: false,
      hooks: {
        wakeUp: true,
        searchGuidance: true,
        autoSearchOnPrompt: true,
        compactionCheckpoint: true,
        shutdownDiary: true,
      },
      budgets: {
        wakeUpTokens: 1200,
        searchResultChars: 12000,
        listResultChars: 12000,
        diaryChars: 8000,
        autoSearchTokens: 150,
        wakeUpInjectionEvery: 10,
      },
      timeouts: {
        setupMs: 120000,
        bridgeMs: 30000,
        hookMs: 10000,
      },
    });
  });

  test("accepts defaults through the top-level config schema", () => {
    expect(validateConfig(DEFAULT_CONFIG)).toEqual({ valid: true, errors: [] });
  });

  test("rejects invalid top-level MemPalace values", () => {
    const result = validateConfig({
      ...DEFAULT_CONFIG,
      mempalace: {
        ...DEFAULT_CONFIG.mempalace,
        defaultWingStrategy: "workspace",
        hooks: {
          ...DEFAULT_CONFIG.mempalace.hooks,
          shutdownDiary: "yes",
        },
      },
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes("mempalace.defaultWingStrategy"))).toBe(true);
    expect(result.errors.some((error) => error.includes("mempalace.hooks.shutdownDiary"))).toBe(true);
  });

  test("rejects unknown MemPalace config keys", () => {
    const result = validateConfig({
      ...DEFAULT_CONFIG,
      mempalace: {
        ...DEFAULT_CONFIG.mempalace,
        mcpServer: true,
      },
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes("mempalace.mcpServer"))).toBe(true);
  });
});

describe("mempalace config helpers", () => {
  let tmpDir: string;
  let repoDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-mempalace-config-"));
    repoDir = path.join(tmpDir, "Supi Powers");
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({ name: "fixture" }));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("expands configured paths without shell interpolation", () => {
    const resolved = resolveMempalaceConfig(
      {
        ...DEFAULT_CONFIG,
        mempalace: {
          ...DEFAULT_CONFIG.mempalace,
          managedVenvPath: "~/.cache/${USER}/mempalace",
          palacePath: "~/palaces/$(whoami)",
        },
      },
      repoDir,
      createPaths(".omp"),
    );

    expect(resolved.managedVenvPath).toBe(path.join(os.homedir(), ".cache", "${USER}", "mempalace"));
    expect(resolved.palacePath).toBe(path.join(os.homedir(), "palaces", "$(whoami)"));
  });

  test("derives repo-name default wing deterministically", () => {
    const resolved = resolveMempalaceConfig(DEFAULT_CONFIG, repoDir, createPaths(".omp"));

    expect(resolveDefaultWing(resolved, repoDir, createPaths(".omp"))).toBe("supi_powers");
  });

  test("derives project-slug default wing from project state directory", () => {
    const paths = createPaths(".omp");
    const resolved = resolveMempalaceConfig(
      {
        ...DEFAULT_CONFIG,
        mempalace: {
          ...DEFAULT_CONFIG.mempalace,
          defaultWingStrategy: "project-slug",
        },
      },
      repoDir,
      paths,
    );

    expect(resolveDefaultWing(resolved, repoDir, paths)).toBe(
      normalizeMempalaceWing(path.basename(getProjectStateDir(paths, repoDir))),
    );
  });

  test("derives explicit default wing and rejects an empty explicit wing", () => {
    const paths = createPaths(".omp");
    const explicit = resolveMempalaceConfig(
      {
        ...DEFAULT_CONFIG,
        mempalace: {
          ...DEFAULT_CONFIG.mempalace,
          defaultWingStrategy: "explicit",
          explicitWing: " Team / Alpha ",
        },
      },
      repoDir,
      paths,
    );

    expect(resolveDefaultWing(explicit, repoDir, paths)).toBe("team_alpha");

    const missing = resolveMempalaceConfig(
      {
        ...DEFAULT_CONFIG,
        mempalace: {
          ...DEFAULT_CONFIG.mempalace,
          defaultWingStrategy: "explicit",
          explicitWing: "  ///  ",
        },
      },
      repoDir,
      paths,
    );

    expect(() => resolveDefaultWing(missing, repoDir, paths)).toThrow("explicitWing");
  });

  test("normalizes wings to mempalace's underscore-canonical slug", () => {
    // Mirrors mempalace.config.normalize_wing_name: hyphens and spaces fold to underscores.
    expect(normalizeMempalaceWing(" Feature/Auth v2 ")).toBe("feature_auth_v2");
    expect(normalizeMempalaceWing("sij-mono")).toBe("sij_mono");
    expect(normalizeMempalaceWing("sij_mono")).toBe("sij_mono");
    expect(normalizeMempalaceWing("___")).toBe("project");
    expect(normalizeMempalaceWing("---")).toBe("project");
    expect(normalizeMempalaceWing("🔥")).toBe("project");
  });
});
