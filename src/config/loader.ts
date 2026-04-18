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
import { getRootConfigPath } from "../workspace/state-paths.js";
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

export interface ConfigResolutionOptions {
  repoRoot?: string;
}

export interface ConfigMutationOptions extends ConfigResolutionOptions {
  scope?: ConfigScope;
}

interface ResolvedConfigContext {
  repoRoot: string;
}

interface ResolvedConfigLayer {
  scope: ConfigScope;
  path: string;
}

function resolveConfigContext(cwd: string, options?: ConfigResolutionOptions): ResolvedConfigContext {
  return { repoRoot: options?.repoRoot ?? cwd };
}

function getGlobalConfigPath(paths: PlatformPaths): string {
  return paths.global("config.json");
}

function getConfigPath(
  paths: PlatformPaths,
  cwd: string,
  scope: ConfigScope,
  options?: ConfigResolutionOptions,
): string {
  const { repoRoot } = resolveConfigContext(cwd, options);

  switch (scope) {
    case "global":
      return getGlobalConfigPath(paths);
    case "root":
      return getRootConfigPath(paths, repoRoot);
  }
}

function getInspectionScopes(): ConfigScope[] {
  return ["global", "root"];
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
      (channel): channel is string => typeof channel === "string" && channel.length > 0,
    );
    if (channels.length > 0) {
      return [...new Set(channels)];
    }
  }

  if (typeof pipeline === "string" && pipeline.length > 0) return [pipeline];
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
  if (release) {
    if ("pipeline" in release || "channels" in release) {
      const pipeline = typeof release.pipeline === "string" ? release.pipeline : null;
      release.channels = normalizeReleaseChannels(release.channels, pipeline);
      delete release.pipeline;
    }
    // Strip legacy "npm" values that may linger in saved configs
    if (Array.isArray(release.channels)) {
      release.channels = (release.channels as string[]).filter((c) => c !== "npm");
    }
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
  ...layers: Array<Record<string, unknown> | null>
 ): Record<string, unknown> {
  let merged = structuredClone(defaults) as unknown as Record<string, unknown>;

  for (const layer of layers) {
    if (layer) {
      merged = applyConfigOverride(merged, layer);
    }
  }

  // The config schema changed without a version bump, so normalize known
  // legacy fields on every load before strict validation runs.
  merged = migrateConfig(merged);

  return merged;
}

interface ResolvedConfigLayerRead extends ResolvedConfigLayer {
  readResult: { data: Record<string, unknown> | null; error: ConfigParseError | null };
}

function readConfigLayers(
  paths: PlatformPaths,
  cwd: string,
  options?: ConfigResolutionOptions,
 ): ResolvedConfigLayerRead[] {
  return getInspectionScopes().map((scope) => {
    const filePath = getConfigPath(paths, cwd, scope, options);
    return {
      scope,
      path: filePath,
      readResult: readJsonFile(scope, filePath),
    };
  });
}

function inspectScopeConfig(
  paths: PlatformPaths,
  cwd: string,
  scope: ConfigScope,
  options?: ConfigResolutionOptions,
 ): ScopedConfigInspection {
  const filePath = getConfigPath(paths, cwd, scope, options);
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
  const mergedConfig = mergeConfigLayers(DEFAULT_CONFIG, readResult.data);
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
  options?: ConfigResolutionOptions,
 ): QualityGateRecoveryInspection {
  return {
    scopes: getInspectionScopes().map((scope) => inspectScopeConfig(paths, cwd, scope, options)),
  };
}

export function writeQualityGatesConfig(
  paths: PlatformPaths,
  cwd: string,
  scope: ConfigScope,
  gates: QualityGatesConfig,
  options?: ConfigResolutionOptions,
 ): void {
  const configPath = getConfigPath(paths, cwd, scope, options);
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
  options?: ConfigResolutionOptions,
 ): boolean {
  const configPath = getConfigPath(paths, cwd, scope, options);
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

function describeConfigSource(source: ConfigParseError["source"]): string {
  return source === "root" ? "repository" : source;
}

export function formatConfigErrors(result: InspectionLoadResult): string {
  const messages = [
    ...result.parseErrors.map(
      (error) => `${describeConfigSource(error.source)} config ${error.path}: ${error.message}`,
    ),
    ...result.validationErrors.map(
      (error) => `${error.path}: ${error.message}`,
    ),
  ];

  return messages.join("\n") || "Unknown config error";
}

function buildInspectionLoadResult(layers: ResolvedConfigLayerRead[]): InspectionLoadResult {
  const mergedConfig = mergeConfigLayers(
    DEFAULT_CONFIG,
    ...layers.map((layer) => layer.readResult.data),
  );
  const parseErrors = layers
    .map((layer) => layer.readResult.error)
    .filter((error): error is ConfigParseError => error !== null);
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

export function inspectConfigAtScope(
  paths: PlatformPaths,
  cwd: string,
  scope: ConfigScope,
  options?: ConfigResolutionOptions,
): InspectionLoadResult {
  const layers = readConfigLayers(paths, cwd, options).filter((layer) =>
    scope === "global"
      ? layer.scope === "global"
      : layer.scope === "global" || layer.scope === "root",
  );

  return buildInspectionLoadResult(layers);
}

export function inspectConfig(
  paths: PlatformPaths,
  cwd: string,
  options?: ConfigResolutionOptions,
): InspectionLoadResult {
  return buildInspectionLoadResult(readConfigLayers(paths, cwd, options));
}

/** Load config with global -> repository layering over defaults. */
export function loadConfig(
  paths: PlatformPaths,
  cwd: string,
  options?: ConfigResolutionOptions,
 ): SupipowersConfig {
  const result = inspectConfig(paths, cwd, options);

  if (!result.effectiveConfig) {
    throw new Error(formatConfigErrors(result));
  }

  return result.effectiveConfig;
}

function assertValidConfig(data: unknown): void {
  const validationErrors = collectConfigValidationErrors(data);

  if (validationErrors.length === 0) {
    return;
  }

  throw new Error(
    validationErrors
      .map((error) => `${error.path}: ${error.message}`)
      .join("\n"),
  );
}


/** Save a full config document to the selected scope. */
export function saveConfig(
  paths: PlatformPaths,
  cwd: string,
  config: SupipowersConfig,
  options?: ConfigMutationOptions,
 ): void {
  assertValidConfig(config);

  const scope = options?.scope ?? "root";
  const configPath = getConfigPath(paths, cwd, scope, options);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

/** Update specific config fields in the selected raw scope. */
export function updateConfig(
  paths: PlatformPaths,
  cwd: string,
  updates: Record<string, unknown>,
  options?: ConfigMutationOptions,
 ): SupipowersConfig {
  const scope = options?.scope ?? "root";
  const configPath = getConfigPath(paths, cwd, scope, options);
  const current = readJsonFile(scope, configPath);
  if (current.error) {
    throw new Error(`${scope} config ${configPath}: ${current.error.message}`);
  }

  const nextScopeData = applyConfigOverride(
    current.data ? structuredClone(current.data) as Record<string, unknown> : {},
    updates,
  );

  const layers = readConfigLayers(paths, cwd, options);
  const mergedConfig = mergeConfigLayers(
    DEFAULT_CONFIG,
    ...layers.map((layer) => layer.scope === scope ? nextScopeData : layer.readResult.data),
  );
  assertValidConfig(mergedConfig);

  writeRawConfigFile(configPath, nextScopeData);
  return mergedConfig as unknown as SupipowersConfig;
}
