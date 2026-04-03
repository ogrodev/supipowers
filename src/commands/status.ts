import type { Platform, PlatformContext } from "../platform/types.js";
import { listPlans } from "../storage/plans.js";
import { loadConfig } from "../config/loader.js";

export function handleStatus(platform: Platform, ctx: PlatformContext): void {
  void (async () => {
    const plans = listPlans(platform.paths, ctx.cwd);
    const config = loadConfig(platform.paths, ctx.cwd);

    const options = [
      `Profile: ${config.defaultProfile}`,
      `Plans: ${plans.length === 0 ? "none" : ""}`,
      ...plans.map((p) => `  · ${p}`),
      "",
      "Close",
    ];

    await ctx.ui.select("Supipowers Status", options, {
      helpText: "Esc to close",
    });
  })();
}

export function registerStatusCommand(platform: Platform): void {
  platform.registerCommand("supi:status", {
    description: "Show project plans and configuration",
    async handler(_args: string | undefined, ctx: any) {
      handleStatus(platform, ctx);
    },
  });
}
