import type { Platform, PlatformContext } from "../platform/types.js";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import { formatConfigErrors, inspectConfig } from "../config/loader.js";
import { loadLatestReport } from "../storage/reports.js";
import { listPlans } from "../storage/plans.js";
import { summarizeEnabledGates } from "../quality/setup.js";

export interface SupiCommandDependencies {
  inspectConfig: typeof inspectConfig;
  loadLatestReport: typeof loadLatestReport;
  listPlans: typeof listPlans;
}

const SUPI_COMMAND_DEPENDENCIES: SupiCommandDependencies = {
  inspectConfig,
  loadLatestReport,
  listPlans,
};

function formatOverviewStatus(platform: Platform, ctx: PlatformContext, deps: SupiCommandDependencies): string[] {
  const inspection = deps.inspectConfig(platform.paths, ctx.cwd);
  const config = inspection.effectiveConfig ?? DEFAULT_CONFIG;
  const latestReport = deps.loadLatestReport(platform.paths, ctx.cwd);
  const plans = deps.listPlans(platform.paths, ctx.cwd);

  return [
    inspection.parseErrors.length > 0 || inspection.validationErrors.length > 0
      ? `Config error: ${formatConfigErrors(inspection).split("\n")[0]}`
      : `Gates: ${summarizeEnabledGates(config.quality.gates)}`,
    `Plans: ${plans.length}`,
    `Last checks: ${latestReport ? `${latestReport.timestamp.slice(0, 10)} (${latestReport.overallStatus})` : "none"}`,
  ];
}

export async function showSupiDialog(
  platform: Platform,
  ctx: PlatformContext,
  deps: SupiCommandDependencies = SUPI_COMMAND_DEPENDENCIES,
): Promise<void> {
  const commands = [
    "/supi:plan     — Start collaborative planning",
    "/supi:review   — Run AI code review pipeline",
    "/supi:agents  — List and manage review agents",
    "/supi:checks   — Run quality gates",
    "/supi:qa       — E2E product testing with Playwright",
    "/supi:fix-pr   — Fix PR review comments",
    "/supi:release  — Release automation",
    "/supi:config   — Manage configuration",
    "/supi:status   — Show project status",
    "/supi:doctor   — Run health checks",
    "/supi:update   — Update to latest version",
    "/supi:context  — Show context breakdown",
    "/supi:optimize-context — Optimize context to save tokens",
  ];
  const status = formatOverviewStatus(platform, ctx, deps);

  const choice = await ctx.ui.select(
    "Supipowers",
    [...commands, "", ...status, "", "Close"],
    { helpText: "Select a command to run · Esc to close" },
  );

  if (choice && choice.startsWith("/supi:")) {
    const commandName = choice.split(" ")[0].slice(1);
    const command = platform.getCommands().find((candidate) => candidate.name === commandName);
    if (command?.handler) {
      await command.handler("", ctx as any);
    }
  }
}

export function handleSupi(platform: Platform, ctx: PlatformContext): void {
  void showSupiDialog(platform, ctx, SUPI_COMMAND_DEPENDENCIES).catch((error) => {
    ctx.ui.notify(`Supipowers error: ${(error as Error).message}`, "error");
  });
}

export function registerSupiCommand(platform: Platform): void {
  platform.registerCommand("supi", {
    description: "Supipowers overview — show available commands and project status",
    async handler(_args: string | undefined, ctx: any) {
      handleSupi(platform, ctx);
    },
  });
}
