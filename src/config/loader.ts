// src/config/loader.ts
import * as fs from "node:fs";
import * as path from "node:path";
import type { SupipowersConfig, ReleaseChannel } from "../types.js";
import type { PlatformPaths } from "../platform/types.js";
import { DEFAULT_CONFIG } from "./defaults.js";
import {
  collectConfigValidationErrors,
  type ConfigParseError,
  type InspectionLoadResult,
} from "./schema.js";

function getProjectConfigPath(paths: PlatformPaths, cwd: string): string {
  return paths.project(cwd, "config.json");
}

function getGlobalConfigPath(paths: PlatformPaths): string {
  return paths.global("config.json");
}

function readJsonFile(
  source: ConfigParseError["source"],
  filePath: string,
): { data: Record<string, unknown> | null; error: ConfigParseError | null } {
  try {
    if (!fs.existsSync(filePath)) {
      return { data: null, error: null };
    }

    return {
      data: JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>,
      error: null,
    };
  } catch (error) {
    return {
      data: null,
      error: {
        source,
        path: filePath,
        message: (error as Error).message,
      },
    };
  }
}

/** Deep merge source into target. Source values override target. */
export function deepMerge<T extends object>(
  target: T,
  source: Record<string, unknown>,
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
        sourceVal as Record<string, unknown>,
      );
    } else {
      result[key] = sourceVal;
    }
  }
  return result as T;
}

function hasOwnNestedProperty(
  value: Record<string, unknown>,
  topLevelKey: string,
  nestedKey: string,
): boolean {
  if (!(topLevelKey in value)) {
    return false;
  }

  const nested = value[topLevelKey];
  return !!nested && typeof nested === "object" && nestedKey in (nested as Record<string, unknown>);
}

function applyConfigOverride(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const merged = deepMerge(base, override) as Record<string, unknown>;

  if (hasOwnNestedProperty(override, "quality", "gates")) {
    const mergedQuality =
      merged.quality && typeof merged.quality === "object" && !Array.isArray(merged.quality)
        ? (merged.quality as Record<string, unknown>)
        : {};
    const overrideQuality = override.quality as Record<string, unknown>;
    mergedQuality.gates = overrideQuality.gates;
    merged.quality = mergedQuality;
  }

  return merged;
}

/** Migrate config from older versions to current. */
function migrateConfig(config: Record<string, unknown>): Record<string, unknown> {
  const migrated = structuredClone(config) as Record<string, unknown>;
  const release = migrated.release;

  if (release && typeof release === "object" && !Array.isArray(release) && "pipeline" in release) {
    const rawRelease = release as Record<string, unknown>;
    const pipeline = typeof rawRelease.pipeline === "string" ? rawRelease.pipeline : null;
    let channels: ReleaseChannel[] = [];

    if (pipeline === "npm") channels = ["npm"];
    else if (pipeline === "github") channels = ["github"];

    delete rawRelease.pipeline;
    rawRelease.channels = channels;
    migrated.release = rawRelease;
  }

  migrated.version = DEFAULT_CONFIG.version;
  return migrated;
}

function mergeConfigLayers(
  defaults: SupipowersConfig,
  globalData: Record<string, unknown> | null,
  projectData: Record<string, unknown> | null,
): Record<string, unknown> {
  let merged = structuredClone(defaults) as unknown as Record<string, unknown>;

  if (globalData) {
    merged = applyConfigOverride(merged, globalData);
  }

  if (projectData) {
    merged = applyConfigOverride(merged, projectData);
  }

  if (merged.version !== DEFAULT_CONFIG.version) {
    merged = migrateConfig(merged);
  }

  return merged;
}

export function formatConfigErrors(result: InspectionLoadResult): string {
  const messages = [
    ...result.parseErrors.map(
      (error) => `${error.source} config ${error.path}: ${error.message}`,
    ),
    ...result.validationErrors.map(
      (error) => `${error.path}: ${error.message}`,
    ),
  ];

  return messages.join("\n") || "Unknown config error";
}

export function inspectConfig(paths: PlatformPaths, cwd: string): InspectionLoadResult {
  const globalRead = readJsonFile("global", getGlobalConfigPath(paths));
  const projectRead = readJsonFile("project", getProjectConfigPath(paths, cwd));
  const mergedConfig = mergeConfigLayers(DEFAULT_CONFIG, globalRead.data, projectRead.data);
  const parseErrors = [globalRead.error, projectRead.error].filter(
    (error): error is ConfigParseError => error !== null,
  );
  const validationErrors = collectConfigValidationErrors(mergedConfig);

  return {
    mergedConfig,
    effectiveConfig:
      parseErrors.length === 0 && validationErrors.length === 0
        ? (mergedConfig as SupipowersConfig)
        : null,
    parseErrors,
    validationErrors,
  };
}

/** Load config with global -> project layering over defaults. */
export function loadConfig(paths: PlatformPaths, cwd: string): SupipowersConfig {
  const result = inspectConfig(paths, cwd);

  if (!result.effectiveConfig) {
    throw new Error(formatConfigErrors(result));
  }

  return result.effectiveConfig;
}

/** Save project-level config. */
export function saveConfig(paths: PlatformPaths, cwd: string, config: SupipowersConfig): void {
  const configPath = getProjectConfigPath(paths, cwd);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

/** Update specific config fields (deep merge into current). */
export function updateConfig(
  paths: PlatformPaths,
  cwd: string,
  updates: Record<string, unknown>,
): SupipowersConfig {
  const current = loadConfig(paths, cwd);
  const updated = applyConfigOverride(
    structuredClone(current) as unknown as Record<string, unknown>,
    updates,
  );
  const validationErrors = collectConfigValidationErrors(updated);

  if (validationErrors.length > 0) {
    throw new Error(
      validationErrors
        .map((error) => `${error.path}: ${error.message}`)
        .join("\n"),
    );
  }

  saveConfig(paths, cwd, updated as SupipowersConfig);
  return updated as SupipowersConfig;
}
