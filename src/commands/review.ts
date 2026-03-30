import type { Platform } from "../platform/types.js";
import { loadConfig } from "../config/loader.js";
import { listProfiles, resolveProfile } from "../config/profiles.js";
import { buildReviewPrompt } from "../quality/gate-runner.js";
import { isLspAvailable } from "../lsp/detector.js";
import { notifyInfo, notifyWarning } from "../notifications/renderer.js";
import { modelRegistry } from "../config/model-registry-instance.js";
import { resolveModelForAction, createModelBridge } from "../config/model-resolver.js";
import { loadModelConfig } from "../config/model-config.js";

modelRegistry.register({
  id: "review",
  category: "command",
  label: "Review",
  harnessRoleHint: "slow",
});

export function registerReviewCommand(platform: Platform): void {
  platform.registerCommand("supi:review", {
    description: "Run quality gates at chosen depth (quick/thorough/full-regression)",
    async handler(args: string | undefined, ctx: any) {
      const config = loadConfig(platform.paths, ctx.cwd);

      let profileOverride: string | undefined;
      if (args?.includes("--quick")) profileOverride = "quick";
      else if (args?.includes("--thorough")) profileOverride = "thorough";
      else if (args?.includes("--full")) profileOverride = "full-regression";
      else if (args?.includes("--profile")) {
        const match = args.match(/--profile\s+(\S+)/);
        if (match) profileOverride = match[1];
      }

      // If no flag provided and UI is available, let the user pick
      if (!profileOverride && ctx.hasUI) {
        const profiles = listProfiles(platform.paths, ctx.cwd);
        const choice = await ctx.ui.select(
          "Review profile",
          profiles,
          {
            initialIndex: profiles.indexOf(config.defaultProfile),
            helpText: "Select review depth · Esc to cancel",
          },
        );
        if (!choice) return;
        profileOverride = choice;
      }

      const profile = resolveProfile(platform.paths, ctx.cwd, config, profileOverride);
      const lsp = isLspAvailable(platform.getActiveTools());

      if (!lsp && profile.gates.lspDiagnostics) {
        notifyWarning(
          ctx,
          "LSP not available",
          "Review will continue without LSP diagnostics. Run /supi:config for setup."
        );
      }

      let changedFiles: string[] = [];
      try {
        const result = await platform.exec("git", ["diff", "--name-only", "HEAD"], { cwd: ctx.cwd });
        if (result.code === 0) {
          changedFiles = result.stdout
            .split("\n")
            .map((f) => f.trim())
            .filter((f) => f.length > 0);
        }
      } catch {
        // If git fails, we'll review without file filtering
      }

      if (changedFiles.length === 0) {
        try {
          const result = await platform.exec("git", ["diff", "--name-only", "--cached"], { cwd: ctx.cwd });
          if (result.code === 0) {
            changedFiles = result.stdout
              .split("\n")
              .map((f) => f.trim())
              .filter((f) => f.length > 0);
          }
        } catch {
          // continue without
        }
      }

      if (changedFiles.length === 0) {
        notifyInfo(ctx, "No changed files detected", "Reviewing all files in scope");
      }

      const reviewPrompt = buildReviewPrompt({
        profile,
        changedFiles,
        testCommand: config.qa.command,
        lspAvailable: lsp,
      });

      notifyInfo(ctx, `Review started`, `profile: ${profile.name}`);

      // Resolve model for this action
      const modelConfig = loadModelConfig(platform.paths, ctx.cwd);
      const bridge = createModelBridge(platform);
      const resolved = resolveModelForAction("review", modelRegistry, modelConfig, bridge);
      if (resolved.source !== "main" && platform.setModel) {
        platform.setModel(resolved.model);
      }

      platform.sendMessage(
        {
          customType: "supi-review",
          content: [{ type: "text", text: reviewPrompt }],
          display: "none",
        },
        { deliverAs: "steer", triggerTurn: true }
      );
    },
  });
}
