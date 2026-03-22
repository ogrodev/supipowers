import type { Platform } from "../platform/types.js";
import { loadConfig, updateConfig } from "../config/loader.js";
import { buildAnalyzerPrompt } from "../release/analyzer.js";
import { notifyInfo } from "../notifications/renderer.js";

export function registerReleaseCommand(platform: Platform): void {
  platform.registerCommand("supi:release", {
    description: "Release automation — version bump, notes, publish",
    async handler(_args, ctx) {
      const config = loadConfig(platform.paths, ctx.cwd);

      let lastTag: string | null = null;
      try {
        const result = await platform.exec("git", ["describe", "--tags", "--abbrev=0"], { cwd: ctx.cwd });
        if (result.code === 0) lastTag = result.stdout.trim();
      } catch {
        // no tags yet
      }

      if (!config.release.pipeline) {
        const choice = await ctx.ui.select(
          "Release Setup — How do you publish?",
          ["npm — npm publish to registry", "github — GitHub Release with gh CLI", "manual — I'll handle publishing myself"],
          { helpText: "Select your release pipeline" },
        );

        if (!choice) return;
        const pipeline = choice.split(" — ")[0];
        updateConfig(platform.paths, ctx.cwd, { release: { pipeline } });
        ctx.ui.notify(`Release pipeline set to: ${pipeline}`, "info");
      }

      notifyInfo(ctx, "Release started", `Pipeline: ${config.release.pipeline || "just configured"}`);

      const prompt = buildAnalyzerPrompt(lastTag);

      platform.sendMessage(
        {
          customType: "supi-release",
          content: [{ type: "text", text: prompt }],
          display: "none",
        },
        { deliverAs: "steer", triggerTurn: true }
      );
    },
  });
}
