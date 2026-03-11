import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { loadConfig, updateConfig } from "../config/loader.js";
import { buildAnalyzerPrompt } from "../release/analyzer.js";
import { notifyInfo } from "../notifications/renderer.js";

export function registerReleaseCommand(pi: ExtensionAPI): void {
  pi.registerCommand("supi:release", {
    description: "Release automation — version bump, notes, publish",
    async handler(_args, ctx) {
      const config = loadConfig(ctx.cwd);

      let lastTag: string | null = null;
      try {
        const result = await pi.exec("git", ["describe", "--tags", "--abbrev=0"], { cwd: ctx.cwd });
        if (result.exitCode === 0) lastTag = result.stdout.trim();
      } catch {
        // no tags yet
      }

      if (!config.release.pipeline) {
        const prompt = [
          "# Release Setup",
          "",
          "This is your first release with supipowers. How do you publish?",
          "",
          "1. **npm** — npm publish to registry",
          "2. **github** — GitHub Release with gh CLI",
          "3. **manual** — I'll handle publishing myself",
          "",
          "Tell me which option, and I'll save it for future releases.",
          "",
          "After you answer, I'll analyze commits and prepare the release.",
        ].join("\n");

        pi.sendMessage(
          {
            customType: "supi-release-setup",
            content: [{ type: "text", text: prompt }],
            display: "none",
          },
          { deliverAs: "steer" }
        );
        return;
      }

      notifyInfo(ctx, "Release started", `Pipeline: ${config.release.pipeline}`);

      const prompt = buildAnalyzerPrompt(lastTag);

      pi.sendMessage(
        {
          customType: "supi-release",
          content: [{ type: "text", text: prompt }],
          display: "none",
        },
        { deliverAs: "steer" }
      );
    },
  });
}
