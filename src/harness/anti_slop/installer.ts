/**
 * Anti-slop backend installer.
 *
 * Writes the per-backend config, ensures `.desloppify/` is gitignored when desloppify is
 * the chosen backend, and triggers `desloppify update-skill <client>` for each agent-skill
 * distribution target the user opted into during Design.
 *
 * Idempotent: running the installer twice with the same inputs is a no-op (existing config
 * files are read first, then either overwritten with identical content or left untouched).
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { Platform, PlatformPaths } from "../../platform/types.js";
import type { HarnessAntiSlopBackend, HarnessLayerRule } from "../../types.js";
import {
  getHarnessFallowConfigPath,
} from "../project-paths.js";

export interface InstallInput {
  cwd: string;
  backend: HarnessAntiSlopBackend;
  /** Layer rules from Design — used to seed fallow's architecture-boundaries section. */
  layerRules: readonly HarnessLayerRule[];
  /** Agent-skill distribution targets (e.g. "claude", "cursor"). */
  skillTargets: readonly string[];
  /** Detected entry points (binaries, packages). Used by fallow's entry section. */
  entryPoints: readonly string[];
  /** When false, the installer dry-runs (writes nothing; returns the planned actions). */
  apply: boolean;
}

export interface InstallResult {
  ok: boolean;
  actions: string[];
  warnings: string[];
}

/**
 * Build the .fallowrc.json content from layer rules + entry points. The schema is a
 * loose JSON object; fallow tolerates unknown keys, so we keep the shape forward-compatible.
 */
export function buildFallowConfig(input: {
  layerRules: readonly HarnessLayerRule[];
  entryPoints: readonly string[];
}): Record<string, unknown> {
  const architecture = input.layerRules.map((rule) => ({
    layer: rule.layer,
    files: rule.globs,
    allowed: rule.allowedImports,
    forbidden: rule.forbiddenImports,
    ...(rule.description ? { description: rule.description } : {}),
  }));
  return {
    "$schema": "https://fallow.dev/schema/v1/.fallowrc.json",
    entryPoints: [...input.entryPoints],
    architecture,
    audits: {
      duplicates: { enabled: true, threshold: 0.85, minTokens: 30 },
      deadCode: { enabled: true },
      complexity: { enabled: true, fileLineLimit: 600 },
      circularDependencies: { enabled: true },
    },
  };
}

/**
 * Install the fallow side: writes `.fallowrc.json` with detected entry points + layer
 * boundaries.
 */
export async function installFallow(
  paths: PlatformPaths,
  input: InstallInput,
): Promise<InstallResult> {
  const actions: string[] = [];
  const warnings: string[] = [];
  const configPath = getHarnessFallowConfigPath(paths, input.cwd);
  const config = buildFallowConfig({
    layerRules: input.layerRules,
    entryPoints: input.entryPoints,
  });
  const serialized = `${JSON.stringify(config, null, 2)}\n`;

  let existing: string | null = null;
  try {
    if (fs.existsSync(configPath)) existing = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    warnings.push(`unable to read existing ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (existing === serialized) {
    actions.push(`.fallowrc.json already up-to-date (no write)`);
    return { ok: true, actions, warnings };
  }

  if (!input.apply) {
    actions.push(`would write ${configPath}`);
    return { ok: true, actions, warnings };
  }

  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, serialized);
    actions.push(`wrote ${configPath}`);
  } catch (error) {
    return {
      ok: false,
      actions,
      warnings: [...warnings, `failed to write ${configPath}: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  return { ok: true, actions, warnings };
}

/** Ensure `.desloppify/` is gitignored. */
export async function ensureDesloppifyGitignore(input: { cwd: string; apply: boolean }): Promise<InstallResult> {
  const actions: string[] = [];
  const warnings: string[] = [];
  const gitignorePath = path.join(input.cwd, ".gitignore");
  const desiredEntry = ".desloppify/";

  let content = "";
  try {
    if (fs.existsSync(gitignorePath)) content = fs.readFileSync(gitignorePath, "utf8");
  } catch (error) {
    warnings.push(`unable to read .gitignore: ${error instanceof Error ? error.message : String(error)}`);
  }

  const lines = content.split(/\r?\n/);
  const has = lines.some((line) => line.trim() === desiredEntry || line.trim() === ".desloppify");
  if (has) {
    actions.push(`.gitignore already contains ${desiredEntry}`);
    return { ok: true, actions, warnings };
  }
  if (!input.apply) {
    actions.push(`would append ${desiredEntry} to .gitignore`);
    return { ok: true, actions, warnings };
  }
  try {
    const append = content.length === 0 || content.endsWith("\n")
      ? `${desiredEntry}\n`
      : `\n${desiredEntry}\n`;
    fs.writeFileSync(gitignorePath, content + append);
    actions.push(`appended ${desiredEntry} to .gitignore`);
  } catch (error) {
    return {
      ok: false,
      actions,
      warnings: [...warnings, `failed to update .gitignore: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  return { ok: true, actions, warnings };
}

/**
 * Run `desloppify update-skill <client>` for each agent-skill distribution target. We
 * never abort on a single client failure — we report the warning and continue so a missing
 * client doesn't block the rest of the install.
 */
export async function distributeAgentSkills(
  platform: Platform,
  input: { cwd: string; targets: readonly string[]; apply: boolean },
): Promise<InstallResult> {
  const actions: string[] = [];
  const warnings: string[] = [];
  if (input.targets.length === 0) {
    actions.push("no skill targets selected; nothing to distribute");
    return { ok: true, actions, warnings };
  }

  if (!input.apply) {
    for (const target of input.targets) {
      actions.push(`would run desloppify update-skill ${target}`);
    }
    return { ok: true, actions, warnings };
  }

  for (const target of input.targets) {
    try {
      const result = await platform.exec(
        "desloppify",
        ["update-skill", target],
        { cwd: input.cwd, timeout: 30_000 },
      );
      if (result.code !== 0) {
        warnings.push(`desloppify update-skill ${target} exited ${result.code}: ${result.stderr.trim()}`);
        continue;
      }
      actions.push(`desloppify update-skill ${target} ok`);
    } catch (error) {
      warnings.push(
        `desloppify update-skill ${target} threw: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { ok: warnings.length === 0, actions, warnings };
}

/**
 * Compose the per-backend install steps. Stage callers should pass `apply: true`; design
 * preview can pass `apply: false` to display the plan.
 */
export async function installAntiSlopBackend(
  platform: Platform,
  paths: PlatformPaths,
  input: InstallInput,
): Promise<InstallResult> {
  const aggregated: InstallResult = { ok: true, actions: [], warnings: [] };
  const fold = (step: InstallResult) => {
    aggregated.actions.push(...step.actions);
    aggregated.warnings.push(...step.warnings);
    if (!step.ok) aggregated.ok = false;
  };

  if (input.backend === "fallow" || input.backend === "hybrid") {
    fold(await installFallow(paths, input));
  }
  if (input.backend === "desloppify" || input.backend === "hybrid") {
    fold(await ensureDesloppifyGitignore({ cwd: input.cwd, apply: input.apply }));
    fold(await distributeAgentSkills(platform, { cwd: input.cwd, targets: input.skillTargets, apply: input.apply }));
  }
  if (input.backend === "supi-native") {
    aggregated.actions.push("supi-native backend selected; no external CLI install required");
  }
  return aggregated;
}
