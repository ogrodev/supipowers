import * as fs from "node:fs";
import * as path from "node:path";
import type { PlatformPaths } from "../platform/types.js";
import type { UiDesignBackendId } from "./types.js";

const CONFIG_FILENAME = "ui-design.json";
const SUPPORTED_BACKENDS: UiDesignBackendId[] = ["local-html"];

export interface UiDesignConfig {
  backend: UiDesignBackendId;
  /** Optional port override for local HTML companion. */
  port?: number;
  /** Optional overrides for the components-scanner glob list. */
  componentsGlobs?: string[];
}

export const DEFAULT_UI_DESIGN_CONFIG: UiDesignConfig = {
  backend: "local-html",
};

function getConfigPath(paths: PlatformPaths, cwd: string): string {
  return paths.project(cwd, CONFIG_FILENAME);
}

function isValidConfig(data: unknown): data is UiDesignConfig {
  if (!data || typeof data !== "object") return false;
  const backend = (data as { backend?: unknown }).backend;
  if (typeof backend !== "string") return false;
  return SUPPORTED_BACKENDS.includes(backend as UiDesignBackendId);
}

export function loadUiDesignConfig(
  paths: PlatformPaths,
  cwd: string,
): UiDesignConfig | null {
  const configPath = getConfigPath(paths, cwd);
  if (!fs.existsSync(configPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    if (!isValidConfig(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveUiDesignConfig(
  paths: PlatformPaths,
  cwd: string,
  config: UiDesignConfig,
): void {
  const configPath = getConfigPath(paths, cwd);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}
