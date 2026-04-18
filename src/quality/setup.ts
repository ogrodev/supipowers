import * as fs from "node:fs";
import * as path from "node:path";
import type { Platform, PlatformContext } from "../platform/types.js";
import type {
  ConfigScope,
  ProjectFacts,
  ProjectFactsTarget,
  QualityGatesConfig,
  SetupGatesResult,
  SetupProposal,
} from "../types.js";
import type { InspectionLoadResult } from "../config/schema.js";
import { validateQualityGates } from "../config/schema.js";
import { writeQualityGatesConfig } from "../config/loader.js";
import { resolvePackageManager } from "../workspace/package-manager.js";
import { discoverWorkspaceTargets } from "../workspace/targets.js";
import { CANONICAL_GATE_ORDER } from "./registry.js";
import { collectReviewGateNotes, detectReviewGates } from "./review-gates.js";
import { suggestQualityGatesWithAi } from "./ai-setup.js";

export type GateSetupMode = "deterministic" | "ai-assisted";

export type SetupGatesProgressEvent =
  | { type: "collecting-project-facts" }
  | { type: "baseline-ready" }
  | { type: "ai-analysis-started" }
  | { type: "ai-analysis-completed" };

export interface SetupGatesOptions {
  mode?: GateSetupMode;
  onProgress?: (event: SetupGatesProgressEvent) => void;
}

export interface GateSetupDialogOptions {
  title?: string;
  intro?: string;
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

function normalizeScriptCommand(command: string | undefined): string | null {
  const trimmed = command?.trim();
  return trimmed ? trimmed : null;
}

function collectProjectTargets(cwd: string): ProjectFactsTarget[] {
  const packageManager = resolvePackageManager(cwd).id;
  const targets = discoverWorkspaceTargets(cwd, packageManager);
  if (targets.length === 0) {
    return [
      {
        name: path.basename(cwd) || "root",
        kind: "root",
        relativeDir: ".",
        packageScripts: readPackageScripts(cwd),
      },
    ];
  }

  return targets.map((target) => ({
    name: target.name,
    kind: target.kind,
    relativeDir: target.relativeDir,
    packageScripts: readPackageScripts(target.packageDir),
  }));
}

function collectSharedPackageScripts(targets: ProjectFactsTarget[]): Record<string, string> {
  if (targets.length === 0) {
    return {};
  }

  const shared = { ...targets[0].packageScripts };
  for (const scriptName of Object.keys(shared)) {
    const command = normalizeScriptCommand(shared[scriptName]);
    if (!command) {
      delete shared[scriptName];
      continue;
    }

    const matchesEveryTarget = targets.slice(1).every(
      (target) => normalizeScriptCommand(target.packageScripts[scriptName]) === command,
    );
    if (!matchesEveryTarget) {
      delete shared[scriptName];
    }
  }

  return shared;
}

export function collectProjectFacts(
  cwd: string,
  inspection: InspectionLoadResult,
  activeTools: string[],
): ProjectFacts {
  const targets = collectProjectTargets(cwd);
  return {
    cwd,
    packageScripts: collectSharedPackageScripts(targets),
    lockfiles: detectLockfiles(cwd),
    activeTools,
    existingGates: inspection.effectiveConfig?.quality.gates ?? {},
    targets,
  };
}

export function summarizeEnabledGates(gates: QualityGatesConfig): string {
  const enabled = CANONICAL_GATE_ORDER.filter((gateId) => gates[gateId]?.enabled === true);

  return enabled.length > 0 ? enabled.join(", ") : "none";
}

export function formatGateProposal(proposal: SetupProposal): string {
  const entries = CANONICAL_GATE_ORDER
    .filter((gateId) => proposal.gates[gateId] !== undefined)
    .map((gateId) => [gateId, proposal.gates[gateId]] as const);
  const sections: string[] = [];

  if (entries.length === 0) {
    sections.push("No gates suggested.");
  } else {
    sections.push(
      entries
        .map(([gateId, config]) => `${gateId}: ${JSON.stringify(config)}`)
        .join("\n"),
    );
  }

  if (proposal.notes && proposal.notes.length > 0) {
    sections.push([
      "Notes:",
      ...proposal.notes.map((note) => `- ${note}`),
    ].join("\n"));
  }

  return sections.join("\n\n");
}

export function buildDeterministicSuggestion(projectFacts: ProjectFacts): SetupProposal {
  const notes = collectReviewGateNotes(projectFacts);
  return {
    gates: detectReviewGates(projectFacts),
    ...(notes.length > 0 ? { notes } : {}),
  };
}

export async function setupGates(
  platform: Platform,
  cwd: string,
  inspection: InspectionLoadResult,
  options: SetupGatesOptions = {},
  deps: SetupGatesDependencies = {},
): Promise<SetupGatesResult> {
  options.onProgress?.({ type: "collecting-project-facts" });
  const projectFacts = collectProjectFacts(cwd, inspection, platform.getActiveTools());
  let proposal = buildDeterministicSuggestion(projectFacts);
  options.onProgress?.({ type: "baseline-ready" });

  if (options.mode === "ai-assisted") {
    options.onProgress?.({ type: "ai-analysis-started" });
    const suggestWithAi = deps.suggestWithAi ?? suggestQualityGatesWithAi;
    proposal = {
      gates: await suggestWithAi({
        platform,
        cwd,
        projectFacts,
        proposal,
      }),
      ...(proposal.notes && proposal.notes.length > 0 ? { notes: proposal.notes } : {}),
    };
    options.onProgress?.({ type: "ai-analysis-completed" });
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

function parseRevisedProposal(raw: string): QualityGatesConfig {
  const parsed = JSON.parse(raw) as QualityGatesConfig;
  const validation = validateQualityGates(parsed);
  if (!validation.valid) {
    throw new Error(validation.errors.join("\n"));
  }

  return parsed;
}

function labelForScope(scope: ConfigScope): string {
  switch (scope) {
    case "global":
      return "Global (~/.omp/supipowers/config.json)";
    case "root":
      return "Repository (.omp/supipowers/config.json)";
  }
}

async function selectSaveScope(ctx: PlatformContext): Promise<ConfigScope | null> {
  const choice = await ctx.ui.select(
    "Save quality gates to",
    [labelForScope("root"), labelForScope("global"), "Cancel"],
    {
      initialIndex: 0,
      helpText: "Choose whether review gates apply only to this repository or all repositories.",
    },
  );

  if (!choice || choice === "Cancel") {
    return null;
  }

  return choice === labelForScope("global") ? "global" : "root";
}

function buildProposalHelpText(proposal: SetupProposal, options?: GateSetupDialogOptions): string {
  return [options?.intro, formatGateProposal(proposal)].filter(Boolean).join("\n\n");
}

export async function interactivelySaveGateSetup(
  ctx: PlatformContext,
  paths: Platform["paths"],
  cwd: string,
  initial: SetupProposal,
  options: GateSetupDialogOptions = {},
): Promise<"saved" | "cancelled"> {
  let proposal = initial;

  while (true) {
    const choice = await ctx.ui.select(
      options.title ?? "Quality gate setup",
      ["Accept", "Revise", "Cancel"],
      { helpText: buildProposalHelpText(proposal, options) },
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
        proposal = {
          ...proposal,
          gates: parseRevisedProposal(revised),
        };
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
