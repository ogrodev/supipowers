// src/config/loader.ts
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ConfigScope,
  SupipowersConfig,
  ReleaseChannel,
  QualityGatesConfig,
} from "../types.js";
import type { PlatformPaths } from "../platform/types.js";
import { DEFAULT_CONFIG } from "./defaults.js";
import {
  collectConfigValidationErrors,
  type ConfigParseError,
  type ConfigValidationError,
  type InspectionLoadResult,
} from "./schema.js";

export interface ScopedConfigInspection {
  scope: ConfigScope;
  path: string;
  data: Record<string, unknown> | null;
  parseError: ConfigParseError | null;
  validationErrors: ConfigValidationError[];
  qualityGateValidationErrors: ConfigValidationError[];
  otherValidationErrors: ConfigValidationError[];
  hasOwnQualityGates: boolean;
  recoverableInvalidQualityGates: boolean;
}

export interface QualityGateRecoveryInspection {
  scopes: ScopedConfigInspection[];
}

function getProjectConfigPath(paths: PlatformPaths, cwd: string): string {
  return paths.project(cwd, "config.json");
}

function getGlobalConfigPath(paths: PlatformPaths): string {
  return paths.global("config.json");
}

function getConfigPath(paths: PlatformPaths, cwd: string, scope: ConfigScope): string {
  return scope === "global" ? getGlobalConfigPath(paths) : getProjectConfigPath(paths, cwd);
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

/** Known legacy config shapes are normalized before validation. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeReleaseChannels(
  existingChannels: unknown,
  pipeline: string | null,
): ReleaseChannel[] {
  if (Array.isArray(existingChannels)) {
    const channels = existingChannels.filter(
      (channel): channel is ReleaseChannel => channel === "github" || channel === "npm",
    );
    if (channels.length > 0) {
      return [...new Set(channels)];
    }
  }

  if (pipeline === "npm") return ["npm"];
  if (pipeline === "github") return ["github"];
  return [];
}

function legacyGatesFromProfile(
  profileName: string | null,
  legacyTestCommand: string | null,
): QualityGatesConfig | null {
  const gates: QualityGatesConfig = {};

  if (profileName === "quick" || profileName === "thorough" || profileName === "full-regression") {
    gates["lsp-diagnostics"] = { enabled: true };
  }

  if (legacyTestCommand) {
    gates["test-suite"] = { enabled: true, command: legacyTestCommand };
  }

  return Object.keys(gates).length > 0 ? gates : null;
}

/** Migrate config from older shapes to the canonical schema. */
function migrateConfig(config: Record<string, unknown>): Record<string, unknown> {
  const migrated = structuredClone(config) as Record<string, unknown>;
  const legacyProfile = typeof migrated.defaultProfile === "string" ? migrated.defaultProfile : null;
  delete migrated.defaultProfile;
  delete migrated.orchestration;

  const qa = asRecord(migrated.qa);
  const legacyTestCommand =
    qa && typeof qa.command === "string" && qa.command.trim().length > 0
      ? qa.command.trim()
      : null;
  if (qa && "command" in qa) {
    delete qa.command;
    migrated.qa = qa;
  }

  const release = asRecord(migrated.release);
  if (release && ("pipeline" in release || "channels" in release)) {
    const pipeline = typeof release.pipeline === "string" ? release.pipeline : null;
    release.channels = normalizeReleaseChannels(release.channels, pipeline);
    delete release.pipeline;
    migrated.release = release;
  }

  const quality = asRecord(migrated.quality);
  if (quality) {
    const gates = asRecord(quality.gates);
    if (gates) {
      // Strip legacy ai-review gate — removed from the schema in the checks/review split.
      delete gates["ai-review"];
    }
    if (!gates || Object.keys(gates).length === 0) {
      const legacyGates = legacyGatesFromProfile(legacyProfile, legacyTestCommand);
      if (legacyGates) {
        quality.gates = legacyGates as unknown as Record<string, unknown>;
      }
    } else if (legacyTestCommand && !("test-suite" in gates)) {
      gates["test-suite"] = { enabled: true, command: legacyTestCommand };
      quality.gates = gates;
    }
    migrated.quality = quality;
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

  // The config schema changed without a version bump, so normalize known
  // legacy fields on every load before strict validation runs.
  merged = migrateConfig(merged);

  return merged;
}

function inspectScopeConfig(
  paths: PlatformPaths,
  cwd: string,
  scope: ConfigScope,
): ScopedConfigInspection {
  const filePath = getConfigPath(paths, cwd, scope);
  const readResult = readJsonFile(scope, filePath);

  if (readResult.error) {
    return {
      scope,
      path: filePath,
      data: null,
      parseError: readResult.error,
      validationErrors: [],
      qualityGateValidationErrors: [],
      otherValidationErrors: [],
      hasOwnQualityGates: false,
      recoverableInvalidQualityGates: false,
    };
  }

  const hasOwnQualityGates = !!readResult.data && hasOwnNestedProperty(readResult.data, "quality", "gates");
  const mergedConfig =
    scope === "global"
      ? mergeConfigLayers(DEFAULT_CONFIG, readResult.data, null)
      : mergeConfigLayers(DEFAULT_CONFIG, null, readResult.data);
  const validationErrors = collectConfigValidationErrors(mergedConfig);
  const qualityGateValidationErrors = hasOwnQualityGates
    ? validationErrors.filter((error) => error.path === "quality.gates" || error.path.startsWith("quality.gates."))
    : [];
  const otherValidationErrors = validationErrors.filter(
    (error) => !qualityGateValidationErrors.includes(error),
  );

  return {
    scope,
    path: filePath,
    data: readResult.data,
    parseError: null,
    validationErrors,
    qualityGateValidationErrors,
    otherValidationErrors,
    hasOwnQualityGates,
    recoverableInvalidQualityGates:
      hasOwnQualityGates && qualityGateValidationErrors.length > 0 && otherValidationErrors.length === 0,
  };
}

function removeQualityGatesFromRecord(config: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(config) as Record<string, unknown>;
  const quality = asRecord(next.quality);
  if (!quality || !("gates" in quality)) {
    return next;
  }

  delete quality.gates;
  if (Object.keys(quality).length === 0) {
    delete next.quality;
  } else {
    next.quality = quality;
  }

  return next;
}

function writeRawConfigFile(filePath: string, config: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n");
}

export function inspectQualityGateRecovery(
  paths: PlatformPaths,
  cwd: string,
): QualityGateRecoveryInspection {
  return {
    scopes: (["global", "project"] as ConfigScope[]).map((scope) =>
      inspectScopeConfig(paths, cwd, scope),
    ),
  };
}

export function writeQualityGatesConfig(
  paths: PlatformPaths,
  cwd: string,
  scope: ConfigScope,
  gates: QualityGatesConfig,
): void {
  const configPath = getConfigPath(paths, cwd, scope);
  const current = readJsonFile(scope, configPath);
  if (current.error) {
    throw new Error(`${scope} config ${configPath}: ${current.error.message}`);
  }

  const next = current.data ? structuredClone(current.data) as Record<string, unknown> : {};
  const quality =
    next.quality && typeof next.quality === "object" && !Array.isArray(next.quality)
      ? { ...(next.quality as Record<string, unknown>) }
      : {};

  quality.gates = gates;
  next.quality = quality;
  writeRawConfigFile(configPath, next);
}

export function removeQualityGatesConfig(
  paths: PlatformPaths,
  cwd: string,
  scope: ConfigScope,
): boolean {
  const configPath = getConfigPath(paths, cwd, scope);
  const current = readJsonFile(scope, configPath);
  if (current.error) {
    throw new Error(`${scope} config ${configPath}: ${current.error.message}`);
  }
  if (!current.data || !hasOwnNestedProperty(current.data, "quality", "gates")) {
    return false;
  }

  writeRawConfigFile(configPath, removeQualityGatesFromRecord(current.data));
  return true;
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
        ? (mergedConfig as unknown as SupipowersConfig)
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

  saveConfig(paths, cwd, updated as unknown as SupipowersConfig);
  return updated as unknown as SupipowersConfig;
}
