import type { Platform, PlatformContext } from "../platform/types.js";
import { formatOverviewStatus } from "./status.js";

export async function showSupiDialog(
  platform: Platform,
  ctx: PlatformContext,
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
  const status = formatOverviewStatus(platform, ctx);

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
  void showSupiDialog(platform, ctx).catch((error) => {
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
