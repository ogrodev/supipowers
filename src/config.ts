import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupipowersConfig } from "./types";

export const DEFAULT_CONFIG: SupipowersConfig = {
  strictness: "balanced",
  showWidget: true,
  showStatus: true,
};

export function loadConfig(cwd: string): SupipowersConfig {
  const configPath = join(cwd, ".pi", "supipowers", "config.json");
  if (!existsSync(configPath)) return DEFAULT_CONFIG;

  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as Partial<SupipowersConfig>;
    return {
      strictness: parsed.strictness ?? DEFAULT_CONFIG.strictness,
      showWidget: parsed.showWidget ?? DEFAULT_CONFIG.showWidget,
      showStatus: parsed.showStatus ?? DEFAULT_CONFIG.showStatus,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}
