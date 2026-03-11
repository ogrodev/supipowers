import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { loadConfig, updateConfig } from "../config/loader.js";
import { listProfiles, resolveProfile } from "../config/profiles.js";
import { notifyInfo, notifySuccess } from "../notifications/renderer.js";

export function registerConfigCommand(pi: ExtensionAPI): void {
  pi.registerCommand("supi:config", {
    description: "View and manage Supipowers configuration and profiles",
    async handler(args, ctx) {
      const config = loadConfig(ctx.cwd);

      if (!args || args.trim() === "") {
        const profiles = listProfiles(ctx.cwd);
        const activeProfile = resolveProfile(ctx.cwd, config);

        const lines = [
          "# Supipowers Configuration",
          "",
          `Profile: ${config.defaultProfile}`,
          `Max parallel agents: ${config.orchestration.maxParallelAgents}`,
          `Max fix retries: ${config.orchestration.maxFixRetries}`,
          `Max nesting depth: ${config.orchestration.maxNestingDepth}`,
          `Model preference: ${config.orchestration.modelPreference}`,
          `LSP auto-detect: ${config.lsp.autoDetect}`,
          `Notification verbosity: ${config.notifications.verbosity}`,
          `QA framework: ${config.qa.framework ?? "not detected"}`,
          `Release pipeline: ${config.release.pipeline ?? "not configured"}`,
          "",
          `Available profiles: ${profiles.join(", ")}`,
          "",
          "To update: /supi:config set <key> <value>",
          "Example: /supi:config set orchestration.maxParallelAgents 5",
        ];

        pi.sendMessage({
          customType: "supi-config",
          content: [{ type: "text", text: lines.join("\n") }],
          display: "inline",
        });
        return;
      }

      const setMatch = args.match(/^set\s+(\S+)\s+(.+)$/);
      if (setMatch) {
        const [, keyPath, rawValue] = setMatch;
        const keys = keyPath.split(".");
        let value: unknown = rawValue;

        if (rawValue === "true") value = true;
        else if (rawValue === "false") value = false;
        else if (rawValue === "null") value = null;
        else if (!isNaN(Number(rawValue))) value = Number(rawValue);

        const update: Record<string, unknown> = {};
        let current = update;
        for (let i = 0; i < keys.length - 1; i++) {
          current[keys[i]] = {};
          current = current[keys[i]] as Record<string, unknown>;
        }
        current[keys[keys.length - 1]] = value;

        updateConfig(ctx.cwd, update);
        notifySuccess(ctx, "Config updated", `${keyPath} = ${rawValue}`);
        return;
      }

      notifyInfo(ctx, "Usage", "/supi:config or /supi:config set <key> <value>");
    },
  });
}
