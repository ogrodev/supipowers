import type { Platform, PlatformContext } from "../platform/types.js";
import { loadConfig } from "../config/loader.js";
import { findActiveRun } from "../storage/runs.js";
import { loadLatestReport } from "../storage/reports.js";
import { listPlans } from "../storage/plans.js";

export function handleSupi(platform: Platform, ctx: PlatformContext): void {
  void (async () => {
    const config = loadConfig(platform.paths, ctx.cwd);
    const activeRun = findActiveRun(platform.paths, ctx.cwd);
    const latestReport = loadLatestReport(platform.paths, ctx.cwd);
    const plans = listPlans(platform.paths, ctx.cwd);

    const commands = [
      "/supi:plan     — Start collaborative planning",
      "/supi:run      — Execute a plan with sub-agents",
      "/supi:review   — Run quality gates",
      "/supi:qa       — E2E product testing with Playwright",
      "/supi:fix-pr   — Fix PR review comments",
      "/supi:release  — Release automation",
      "/supi:config   — Manage configuration",
      "/supi:status   — Check running tasks",
      "/supi:update   — Update to latest version",
    ];

    const status = [
      `Profile: ${config.defaultProfile}`,
      `Plans: ${plans.length}`,
      `Active run: ${activeRun ? activeRun.id : "none"}`,
      `Last review: ${latestReport ? `${latestReport.timestamp.slice(0, 10)} (${latestReport.passed ? "passed" : "failed"})` : "none"}`,
    ];

    const choice = await ctx.ui.select(
      "Supipowers",
      [...commands, "", ...status, "", "Close"],
      { helpText: "Select a command to run · Esc to close" },
    );

    if (choice && choice.startsWith("/supi:")) {
      const cmdName = choice.split(" ")[0].slice(1); // remove leading /
      const cmd = platform.getCommands().find((c) => c.name === cmdName);
      if (cmd?.handler) {
        await cmd.handler("", ctx as any);
      }
    }
  })().catch((err) => {
    ctx.ui.notify(`Supipowers error: ${(err as Error).message}`, "error");
  });
}

export function registerSupiCommand(platform: Platform): void {
  platform.registerCommand("supi", {
    description: "Supipowers overview — show available commands and project status",
    async handler(_args: string | undefined, ctx: any) {
      // Handled via input event interception — this is a fallback for non-interactive contexts
      handleSupi(platform, ctx);
    },
  });
}
