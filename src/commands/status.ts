import * as fs from "node:fs";
import * as path from "node:path";
import type { Platform, PlatformContext } from "../platform/types.js";
import type { ConfigResolutionOptions } from "../config/loader.js";
import type { PackageManagerId, ReviewReport, WorkspaceTarget } from "../types.js";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import { formatConfigErrors, inspectConfig } from "../config/loader.js";
import { loadLatestReport } from "../storage/reports.js";
import { summarizeEnabledGates } from "../quality/setup.js";
import { detectPackageManager } from "../workspace/package-manager.js";
import { getTargetStatePath } from "../workspace/state-paths.js";
import { discoverWorkspaceTargets } from "../workspace/targets.js";

export interface StatusCommandDependencies {
  inspectConfig: typeof inspectConfig;
  loadLatestReport: typeof loadLatestReport;
  detectPackageManager: typeof detectPackageManager;
  discoverWorkspaceTargets: typeof discoverWorkspaceTargets;
}

interface TargetStatusSnapshot {
  target: WorkspaceTarget;
  label: string;
  shortLabel: string;
  configSummary: string;
  plans: string[];
  latestReport: ReviewReport | null;
}

interface StatusSnapshot {
  targets: TargetStatusSnapshot[];
  isMonorepo: boolean;
  workspaceCount: number;
  targetsWithPlans: number;
  targetsWithReports: number;
}

const STATUS_COMMAND_DEPENDENCIES: StatusCommandDependencies = {
  inspectConfig,
  loadLatestReport,
  detectPackageManager,
  discoverWorkspaceTargets,
};

function createFallbackRootTarget(repoRoot: string, packageManager: PackageManagerId): WorkspaceTarget {
  const repoName = path.basename(repoRoot) || "repo-root";

  return {
    id: repoName,
    name: repoName,
    kind: "root",
    repoRoot,
    packageDir: repoRoot,
    manifestPath: path.join(repoRoot, "package.json"),
    relativeDir: ".",
    version: "0.0.0",
    private: false,
    packageManager,
  };
}

function getTargetConfigOptions(target: WorkspaceTarget): ConfigResolutionOptions {
  return target.kind === "root"
    ? { repoRoot: target.repoRoot }
    : { repoRoot: target.repoRoot, workspaceRelativeDir: target.relativeDir };
}

function listPlansForTarget(platform: Platform, target: WorkspaceTarget): string[] {
  const plansDir = getTargetStatePath(platform.paths, target, "plans");
  if (!fs.existsSync(plansDir)) {
    return [];
  }

  return fs
    .readdirSync(plansDir)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .reverse();
}

function summarizeTargetConfig(
  platform: Platform,
  ctx: PlatformContext,
  deps: StatusCommandDependencies,
  target: WorkspaceTarget,
): string {
  const inspection = deps.inspectConfig(platform.paths, ctx.cwd, getTargetConfigOptions(target));
  const config = inspection.effectiveConfig ?? DEFAULT_CONFIG;

  if (inspection.parseErrors.length > 0 || inspection.validationErrors.length > 0) {
    return `Config error: ${formatConfigErrors(inspection).split("\n")[0]}`;
  }

  return `Gates: ${summarizeEnabledGates(config.quality.gates)}`;
}

function createTargetLabel(target: WorkspaceTarget): string {
  return target.kind === "root"
    ? `${target.name} (root)`
    : `${target.name} (${target.relativeDir})`;
}

function createTargetShortLabel(target: WorkspaceTarget): string {
  return target.kind === "root" ? "root" : target.name;
}

function collectStatusSnapshot(
  platform: Platform,
  ctx: PlatformContext,
  deps: StatusCommandDependencies,
): StatusSnapshot {
  const packageManager = deps.detectPackageManager(ctx.cwd);
  const discoveredTargets = deps.discoverWorkspaceTargets(ctx.cwd, packageManager);
  const targets = discoveredTargets.length > 0
    ? discoveredTargets
    : [createFallbackRootTarget(ctx.cwd, packageManager)];

  const snapshots = targets.map((target) => {
    const latestReport = deps.loadLatestReport(platform.paths, target);
    const plans = listPlansForTarget(platform, target);

    return {
      target,
      label: createTargetLabel(target),
      shortLabel: createTargetShortLabel(target),
      configSummary: summarizeTargetConfig(platform, ctx, deps, target),
      plans,
      latestReport,
    } satisfies TargetStatusSnapshot;
  });

  return {
    targets: snapshots,
    isMonorepo: snapshots.length > 1,
    workspaceCount: snapshots.filter((snapshot) => snapshot.target.kind === "workspace").length,
    targetsWithPlans: snapshots.filter((snapshot) => snapshot.plans.length > 0).length,
    targetsWithReports: snapshots.filter((snapshot) => snapshot.latestReport !== null).length,
  };
}

function formatLatestReport(report: ReviewReport | null): string {
  return report ? `${report.timestamp.slice(0, 10)} (${report.overallStatus})` : "none";
}

function summarizePlanTargets(snapshot: StatusSnapshot): string {
  const entries = snapshot.targets
    .filter((target) => target.plans.length > 0)
    .map((target) => `${target.shortLabel}: ${target.plans.length}`);

  return entries.join(" · ") || "none";
}

function summarizeReportTargets(snapshot: StatusSnapshot): string {
  const entries = snapshot.targets
    .filter((target) => target.latestReport)
    .map((target) => `${target.shortLabel}: ${formatLatestReport(target.latestReport)}`);

  return entries.join(" · ") || "none";
}

function summarizeConfigProblems(snapshot: StatusSnapshot): string {
  const entries = snapshot.targets
    .filter((target) => target.configSummary.startsWith("Config error:"))
    .map((target) => `${target.shortLabel}: ${target.configSummary.slice("Config error: ".length)}`);

  return entries.join(" · ") || "none";
}

export function formatOverviewStatus(
  platform: Platform,
  ctx: PlatformContext,
  deps: StatusCommandDependencies = STATUS_COMMAND_DEPENDENCIES,
): string[] {
  const snapshot = collectStatusSnapshot(platform, ctx, deps);

  if (!snapshot.isMonorepo) {
    const [target] = snapshot.targets;
    return [
      target.configSummary,
      `Plans: ${target.plans.length}`,
      `Last checks: ${formatLatestReport(target.latestReport)}`,
    ];
  }

  return [
    `Packages: ${snapshot.targets.length} targets · ${snapshot.workspaceCount} workspaces`,
    `Config issues: ${summarizeConfigProblems(snapshot)}`,
    `Plans: ${summarizePlanTargets(snapshot)}`,
    `Last checks: ${summarizeReportTargets(snapshot)}`,
  ];
}

function formatStatusOptions(snapshot: StatusSnapshot): string[] {
  if (!snapshot.isMonorepo) {
    const [target] = snapshot.targets;
    return [
      target.configSummary,
      `Plans: ${target.plans.length === 0 ? "none" : target.plans.length}`,
      ...target.plans.map((plan) => `  · ${plan}`),
      `Last checks: ${formatLatestReport(target.latestReport)}`,
      "",
      "Close",
    ];
  }

  const options = [
    `Packages: ${snapshot.targets.length} targets · ${snapshot.workspaceCount} workspaces`,
    `Artifacts: ${snapshot.targetsWithPlans} with plans · ${snapshot.targetsWithReports} with reports`,
    "",
  ];

  for (const target of snapshot.targets) {
    options.push(
      target.label,
      `  ${target.configSummary}`,
      `  Plans: ${target.plans.length === 0 ? "none" : target.plans.length}`,
      ...target.plans.map((plan) => `    · ${plan}`),
      `  Last checks: ${formatLatestReport(target.latestReport)}`,
      "",
    );
  }

  options.push("Close");
  return options;
}

export async function showStatusDialog(
  platform: Platform,
  ctx: PlatformContext,
  deps: StatusCommandDependencies = STATUS_COMMAND_DEPENDENCIES,
): Promise<void> {
  const snapshot = collectStatusSnapshot(platform, ctx, deps);

  await ctx.ui.select("Supipowers Status", formatStatusOptions(snapshot), {
    helpText: "Esc to close",
  });
}

export function handleStatus(platform: Platform, ctx: PlatformContext): void {
  void showStatusDialog(platform, ctx, STATUS_COMMAND_DEPENDENCIES);
}

export function registerStatusCommand(platform: Platform): void {
  platform.registerCommand("supi:status", {
    description: "Show project plans and configuration",
    async handler(_args: string | undefined, ctx: any) {
      handleStatus(platform, ctx);
    },
  });
}
