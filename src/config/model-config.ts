import * as fs from "node:fs";
import * as path from "node:path";
import type { ModelConfig, ModelAssignment } from "../types.js";
import type { PlatformPaths } from "../platform/types.js";
import { loadConfig } from "./loader.js";

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  version: "1.0.0",
  default: null,
  actions: {},
};

export type AssignmentSource =
  | "action-project"
  | "action-global"
  | "default-project"
  | "default-global"
  | "harness"
  | "main";

function getProjectModelPath(paths: PlatformPaths, cwd: string): string {
  return paths.project(cwd, "model.json");
}

function getGlobalModelPath(paths: PlatformPaths): string {
  return paths.global("model.json");
}

function readModelJson(filePath: string): ModelConfig | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as ModelConfig;
  } catch {
    return null;
  }
}

function mergeModelConfigs(base: ModelConfig, override: ModelConfig): ModelConfig {
  const merged: ModelConfig = {
    version: override.version || base.version,
    default: override.default ?? base.default,
    actions: { ...base.actions },
  };
  for (const [key, value] of Object.entries(override.actions)) {
    merged.actions[key] = value;
  }
  return merged;
}

export function loadModelConfig(paths: PlatformPaths, cwd: string): ModelConfig {
  const globalConfig = readModelJson(getGlobalModelPath(paths));
  const projectConfig = readModelJson(getProjectModelPath(paths, cwd));

  let config = { ...DEFAULT_MODEL_CONFIG, actions: {} };
  if (globalConfig) config = mergeModelConfigs(config, globalConfig);
  if (projectConfig) config = mergeModelConfigs(config, projectConfig);

  return config;
}

function loadScopedModelConfig(
  paths: PlatformPaths,
  cwd: string,
  scope: "global" | "project",
): ModelConfig {
  const filePath =
    scope === "global" ? getGlobalModelPath(paths) : getProjectModelPath(paths, cwd);
  return readModelJson(filePath) ?? { ...DEFAULT_MODEL_CONFIG, actions: {} };
}

function saveScopedModelConfig(
  paths: PlatformPaths,
  cwd: string,
  scope: "global" | "project",
  config: ModelConfig,
): void {
  const filePath =
    scope === "global" ? getGlobalModelPath(paths) : getProjectModelPath(paths, cwd);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n");
}

export function saveModelAssignment(
  paths: PlatformPaths,
  cwd: string,
  scope: "global" | "project",
  actionId: string | null,
  assignment: ModelAssignment | null,
): void {
  const config = loadScopedModelConfig(paths, cwd, scope);

  if (actionId === null) {
    config.default = assignment;
  } else if (assignment === null) {
    delete config.actions[actionId];
  } else {
    config.actions[actionId] = assignment;
  }

  saveScopedModelConfig(paths, cwd, scope, config);
}

export function getAssignmentSource(
  paths: PlatformPaths,
  cwd: string,
  actionId: string,
): AssignmentSource {
  const projectConfig = readModelJson(getProjectModelPath(paths, cwd));
  const globalConfig = readModelJson(getGlobalModelPath(paths));

  if (projectConfig?.actions?.[actionId]) return "action-project";
  if (globalConfig?.actions?.[actionId]) return "action-global";
  if (projectConfig?.default) return "default-project";
  if (globalConfig?.default) return "default-global";

  return "main";
}

export function migrateModelPreference(paths: PlatformPaths, cwd: string): void {
  const modelPath = getProjectModelPath(paths, cwd);
  if (fs.existsSync(modelPath)) return; // already has model.json

  const config = loadConfig(paths, cwd);
  const pref = config.orchestration.modelPreference;
  if (!pref || pref === "auto") return; // nothing to migrate

  const migrated: ModelConfig = {
    version: "1.0.0",
    default: { model: pref, thinkingLevel: null },
    actions: {},
  };

  fs.mkdirSync(path.dirname(modelPath), { recursive: true });
  fs.writeFileSync(modelPath, JSON.stringify(migrated, null, 2) + "\n");
}
