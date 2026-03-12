import * as fs from "node:fs";
import * as path from "node:path";
import type { FixPrConfig } from "./types.js";

const CONFIG_FILENAME = "fix-pr.json";

function getConfigPath(cwd: string): string {
  return path.join(cwd, ".omp", "supipowers", CONFIG_FILENAME);
}

export const DEFAULT_FIX_PR_CONFIG: FixPrConfig = {
  reviewer: { type: "none", triggerMethod: null },
  commentPolicy: "answer-selective",
  loop: { delaySeconds: 180, maxIterations: 3 },
  models: {
    orchestrator: { provider: "anthropic", model: "claude-opus-4-6", tier: "high" },
    planner: { provider: "anthropic", model: "claude-opus-4-6", tier: "high" },
    fixer: { provider: "anthropic", model: "claude-sonnet-4-6", tier: "low" },
  },
};

export function loadFixPrConfig(cwd: string): FixPrConfig | null {
  const configPath = getConfigPath(cwd);
  if (!fs.existsSync(configPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8")) as FixPrConfig;
  } catch {
    return null;
  }
}

export function saveFixPrConfig(cwd: string, config: FixPrConfig): void {
  const configPath = getConfigPath(cwd);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}
