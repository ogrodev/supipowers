import * as fs from "node:fs";
import * as path from "node:path";
import type { Platform, PlatformContext, PlatformPaths } from "../platform/types.js";
import type {
  ProjectFacts,
  QualityGatesConfig,
  SetupGatesResult,
  SetupProposal,
} from "../types.js";
import type { InspectionLoadResult } from "../config/schema.js";
import { validateQualityGates } from "../config/schema.js";

export interface SetupGatesOptions {
  mode?: "deterministic" | "ai-assisted";
}

export interface SetupGatesDependencies {
  suggestWithAi?: (input: {
    platform: Platform;
    cwd: string;
    projectFacts: ProjectFacts;
    proposal: SetupProposal;
  }) => Promise<QualityGatesConfig>;
}

function readPackageScripts(cwd: string): Record<string, string> {
  const packageJsonPath = path.join(cwd, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return {};
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as {
      scripts?: Record<string, string>;
    };
    return parsed.scripts ?? {};
  } catch {
    return {};
  }
}

function detectLockfiles(cwd: string): string[] {
  return ["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"]
    .filter((file) => fs.existsSync(path.join(cwd, file)));
}

export function collectProjectFacts(
  cwd: string,
  inspection: InspectionLoadResult,
  activeTools: string[],
): ProjectFacts {
  return {
    cwd,
    packageScripts: readPackageScripts(cwd),
    lockfiles: detectLockfiles(cwd),
    activeTools,
    existingGates: inspection.effectiveConfig?.quality.gates ?? {},
  };
}

export function summarizeEnabledGates(gates: QualityGatesConfig): string {
  const enabled = Object.entries(gates)
    .filter(([, config]) => config?.enabled === true)
    .map(([gateId]) => gateId);

  return enabled.length > 0 ? enabled.join(", ") : "none";
}

export function formatGateProposal(proposal: SetupProposal): string {
  const entries = Object.entries(proposal.gates);
  if (entries.length === 0) {
    return "No gates suggested.";
  }

  return entries
    .map(([gateId, config]) => `${gateId}: ${JSON.stringify(config)}`)
    .join("\n");
}

export function buildDeterministicSuggestion(projectFacts: ProjectFacts): SetupProposal {
  const gates: QualityGatesConfig = {
    "ai-review": { enabled: true, depth: "deep" },
  };

  if (projectFacts.activeTools.some((tool) => tool.toLowerCase().includes("lsp"))) {
    gates["lsp-diagnostics"] = { enabled: true };
  }

  const testCommand = projectFacts.packageScripts.test?.trim();
  if (testCommand) {
    gates["test-suite"] = { enabled: true, command: testCommand };
  }

  return { gates };
}

export async function setupGates(
  platform: Platform,
  cwd: string,
  inspection: InspectionLoadResult,
  options: SetupGatesOptions = {},
  deps: SetupGatesDependencies = {},
): Promise<SetupGatesResult> {
  const projectFacts = collectProjectFacts(cwd, inspection, platform.getActiveTools());
  let proposal = buildDeterministicSuggestion(projectFacts);

  if (options.mode === "ai-assisted" && deps.suggestWithAi) {
    proposal = {
      gates: await deps.suggestWithAi({
        platform,
        cwd,
        projectFacts,
        proposal,
      }),
    };
  }

  const validation = validateQualityGates(proposal.gates);
  if (!validation.valid) {
    return {
      status: "invalid",
      proposal,
      errors: validation.errors,
    };
  }

  return {
    status: "proposed",
    proposal,
  };
}

function getProjectConfigPath(paths: PlatformPaths, cwd: string): string {
  return paths.project(cwd, "config.json");
}

function readProjectConfigFile(paths: PlatformPaths, cwd: string): Record<string, unknown> {
  const configPath = getProjectConfigPath(paths, cwd);
  if (!fs.existsSync(configPath)) {
    return {};
  }

  return JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
}

export function writeProjectQualityGates(
  paths: PlatformPaths,
  cwd: string,
  gates: QualityGatesConfig,
): void {
  const configPath = getProjectConfigPath(paths, cwd);
  const current = readProjectConfigFile(paths, cwd);
  const quality =
    current.quality && typeof current.quality === "object" && !Array.isArray(current.quality)
      ? { ...(current.quality as Record<string, unknown>) }
      : {};

  quality.gates = gates;
  current.quality = quality;

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(current, null, 2) + "\n");
}

function parseRevisedProposal(raw: string): SetupProposal {
  const parsed = JSON.parse(raw) as QualityGatesConfig;
  const validation = validateQualityGates(parsed);
  if (!validation.valid) {
    throw new Error(validation.errors.join("\n"));
  }

  return { gates: parsed };
}

export async function interactivelySaveGateSetup(
  ctx: PlatformContext,
  paths: PlatformPaths,
  cwd: string,
  initial: SetupProposal,
): Promise<"saved" | "cancelled"> {
  let proposal = initial;

  while (true) {
    const choice = await ctx.ui.select(
      "Quality gate setup",
      ["Accept", "Revise", "Cancel"],
      { helpText: formatGateProposal(proposal) },
    );

    if (!choice || choice === "Cancel") {
      return "cancelled";
    }

    if (choice === "Revise") {
      const revised = await ctx.ui.input(
        "Edit quality.gates JSON",
        { value: JSON.stringify(proposal.gates, null, 2) },
      );

      if (!revised) {
        continue;
      }

      try {
        proposal = parseRevisedProposal(revised);
      } catch (error) {
        ctx.ui.notify((error as Error).message, "error");
      }
      continue;
    }

    writeProjectQualityGates(paths, cwd, proposal.gates);
    return "saved";
  }
}
