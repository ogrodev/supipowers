import type { Platform, PlatformContext } from "../platform/types.js";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import { formatConfigErrors, inspectConfig } from "../config/loader.js";
import { listPlans } from "../storage/plans.js";
import { summarizeEnabledGates } from "../quality/setup.js";

export interface StatusCommandDependencies {
  inspectConfig: typeof inspectConfig;
  listPlans: typeof listPlans;
}

const STATUS_COMMAND_DEPENDENCIES: StatusCommandDependencies = {
  inspectConfig,
  listPlans,
};

function formatStatusSummary(platform: Platform, ctx: PlatformContext, deps: StatusCommandDependencies): string {
  const inspection = deps.inspectConfig(platform.paths, ctx.cwd);
  const config = inspection.effectiveConfig ?? DEFAULT_CONFIG;

  if (inspection.parseErrors.length > 0 || inspection.validationErrors.length > 0) {
    return `Config error: ${formatConfigErrors(inspection).split("\n")[0]}`;
  }

  return `Gates: ${summarizeEnabledGates(config.quality.gates)}`;
}

export async function showStatusDialog(
  platform: Platform,
  ctx: PlatformContext,
  deps: StatusCommandDependencies = STATUS_COMMAND_DEPENDENCIES,
): Promise<void> {
  const plans = deps.listPlans(platform.paths, ctx.cwd);
  const options = [
    formatStatusSummary(platform, ctx, deps),
    `Plans: ${plans.length === 0 ? "none" : ""}`,
    ...plans.map((plan) => `  · ${plan}`),
    "",
    "Close",
  ];

  await ctx.ui.select("Supipowers Status", options, {
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
