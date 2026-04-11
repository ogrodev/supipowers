import * as fs from "node:fs";
import * as path from "node:path";
import type { Platform, PlatformContext } from "../platform/types.js";
import type {
  ConfigScope,
  ProjectFacts,
  QualityGatesConfig,
  SetupGatesResult,
  SetupProposal,
} from "../types.js";
import type { InspectionLoadResult } from "../config/schema.js";
import { validateQualityGates } from "../config/schema.js";
import { writeQualityGatesConfig } from "../config/loader.js";

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

function parseRevisedProposal(raw: string): SetupProposal {
  const parsed = JSON.parse(raw) as QualityGatesConfig;
  const validation = validateQualityGates(parsed);
  if (!validation.valid) {
    throw new Error(validation.errors.join("\n"));
  }

  return { gates: parsed };
}

function labelForScope(scope: ConfigScope): string {
  return scope === "project"
    ? "Project (.omp/supipowers/config.json)"
    : "Global (~/.omp/supipowers/config.json)";
}

async function selectSaveScope(ctx: PlatformContext): Promise<ConfigScope | null> {
  const choice = await ctx.ui.select(
    "Save quality gates to",
    [labelForScope("project"), labelForScope("global"), "Cancel"],
    {
      initialIndex: 0,
      helpText: "Choose whether review gates apply only to this project or all projects.",
    },
  );

  if (!choice || choice === "Cancel") {
    return null;
  }

  return choice === labelForScope("global") ? "global" : "project";
}

export async function interactivelySaveGateSetup(
  ctx: PlatformContext,
  paths: Platform["paths"],
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

    const scope = await selectSaveScope(ctx);
    if (!scope) {
      return "cancelled";
    }

    writeQualityGatesConfig(paths, cwd, scope, proposal.gates);
    return "saved";
  }
}
