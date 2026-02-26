import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  detectReleasePreset,
  hasReleasePipeline,
  releasePipelinePath,
  releasePipelineTemplate,
  saveReleasePipeline,
  type ReleasePreset,
} from "../release/pipeline-config";

interface SetupArgs {
  preset?: ReleasePreset;
  force: boolean;
}

const PRESETS: ReleasePreset[] = ["node", "python", "rust", "go", "generic"];

function parseSetupArgs(args: string): SetupArgs {
  const tokens = args
    .trim()
    .split(/\s+/)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);

  const force = tokens.includes("--force");
  const positional = tokens.find((token) => !token.startsWith("--"));
  const preset = PRESETS.includes(positional as ReleasePreset) ? (positional as ReleasePreset) : undefined;

  return { preset, force };
}

export function registerSpReleaseSetupCommand(pi: ExtensionAPI): void {
  pi.registerCommand("sp-release-setup", {
    description: "Create/update repo release pipeline config for /sp-release",
    async handler(args, ctx) {
      const parsed = parseSetupArgs(args);
      let preset = parsed.preset ?? detectReleasePreset(ctx.cwd);

      if (!parsed.preset && ctx.hasUI) {
        const selected = await ctx.ui.select(
          "Select release pipeline preset",
          PRESETS.map((name) => `${name}${name === preset ? " (detected)" : ""}`),
        );
        if (selected) {
          const normalized = selected.split(" ")[0] as ReleasePreset;
          if (PRESETS.includes(normalized)) preset = normalized;
        }
      }

      if (!parsed.force && hasReleasePipeline(ctx.cwd) && ctx.hasUI) {
        const ok = await ctx.ui.confirm(
          "Release pipeline exists",
          "A release pipeline config already exists. Overwrite it?",
        );
        if (!ok) {
          ctx.ui.notify("Setup cancelled. Existing pipeline kept.", "info");
          return;
        }
      }

      const config = releasePipelineTemplate(preset);
      const path = saveReleasePipeline(ctx.cwd, config);

      if (ctx.hasUI) {
        ctx.ui.notify(
          [
            `Release pipeline setup complete using preset '${preset}'.`,
            `Config file: ${path}`,
            "You can edit this file to adapt commands for your repo/tech stack.",
            "Then run: /sp-release <version> --dry-run",
          ].join("\n"),
          "info",
        );
      }
    },
  });
}

export { parseSetupArgs };
