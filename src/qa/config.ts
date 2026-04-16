import * as fs from "node:fs";
import * as path from "node:path";
import type { PlatformPaths } from "../platform/types.js";
import type { WorkspaceTarget } from "../types.js";
import { getTargetStatePath } from "../workspace/state-paths.js";
import type { E2eQaConfig } from "./types.js";

const CONFIG_FILENAME = "e2e-qa.json";

function getConfigPath(paths: PlatformPaths, cwd: string, target?: WorkspaceTarget): string {
  if (target) {
    return getTargetStatePath(paths, target, CONFIG_FILENAME);
  }

  return paths.project(cwd, CONFIG_FILENAME);
}

export const DEFAULT_E2E_QA_CONFIG: E2eQaConfig = {
  app: {
    type: "generic",
    devCommand: "npm run dev",
    port: 3000,
    baseUrl: "http://localhost:3000",
  },
  playwright: {
    headless: true,
    timeout: 30000,
  },
  execution: {
    maxRetries: 2,
    maxFlows: 20,
  },
};

export function loadE2eQaConfig(paths: PlatformPaths, cwd: string, target?: WorkspaceTarget): E2eQaConfig | null {
  const configPath = getConfigPath(paths, cwd, target);
  if (!fs.existsSync(configPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8")) as E2eQaConfig;
  } catch {
    return null;
  }
}

export function saveE2eQaConfig(paths: PlatformPaths, cwd: string, config: E2eQaConfig, target?: WorkspaceTarget): void {
  const configPath = getConfigPath(paths, cwd, target);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}
