// src/config/loader.ts
import * as fs from "node:fs";
import * as path from "node:path";
import type { SupipowersConfig } from "../types.js";
import type { PlatformPaths } from "../platform/types.js";
import { DEFAULT_CONFIG } from "./defaults.js";

function getProjectConfigPath(paths: PlatformPaths, cwd: string): string {
  return paths.project(cwd, "config.json");
}

function getGlobalConfigPath(paths: PlatformPaths): string {
  return paths.global("config.json");
}

function readJsonSafe(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

/** Deep merge source into target. Source values override target. */
export function deepMerge<T extends object>(
  target: T,
  source: Record<string, unknown>
): T {
  const result = { ...target } as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = result[key];
    if (
      sourceVal !== null &&
      typeof sourceVal === "object" &&
      !Array.isArray(sourceVal) &&
      targetVal !== null &&
      typeof targetVal === "object" &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>
      );
    } else {
      result[key] = sourceVal;
    }
  }
  return result as T;
}

/** Load config with global -> project layering over defaults.
 *  Validates and migrates if version is outdated. */
export function loadConfig(paths: PlatformPaths, cwd: string): SupipowersConfig {
  const globalData = readJsonSafe(getGlobalConfigPath(paths));
  const projectData = readJsonSafe(getProjectConfigPath(paths, cwd));

  let config = { ...DEFAULT_CONFIG };
  if (globalData) config = deepMerge(config, globalData);
  if (projectData) config = deepMerge(config, projectData);

  // Migrate if version is older than current default
  if (config.version !== DEFAULT_CONFIG.version) {
    config = migrateConfig(config);
    // Persist migrated config if project-level exists
    if (projectData) saveConfig(paths, cwd, config);
  }

  return config;
}

/** Migrate config from older versions to current */
function migrateConfig(config: SupipowersConfig): SupipowersConfig {
  // Currently v1.0.0 is the only version — future migrations go here
  // Each migration handles one version bump:
  // if (config.version === "0.x.x") { ... config.version = "1.0.0"; }
  return { ...config, version: DEFAULT_CONFIG.version };
}

/** Save project-level config */
export function saveConfig(paths: PlatformPaths, cwd: string, config: SupipowersConfig): void {
  const configPath = getProjectConfigPath(paths, cwd);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

/** Update specific config fields (deep merge into current) */
export function updateConfig(
  paths: PlatformPaths,
  cwd: string,
  updates: Record<string, unknown>
): SupipowersConfig {
  const current = loadConfig(paths, cwd);
  const updated = deepMerge(current, updates) as SupipowersConfig;
  saveConfig(paths, cwd, updated);
  return updated;
}
