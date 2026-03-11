import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { loadConfig, updateConfig } from "../config/loader.js";
import { listProfiles } from "../config/profiles.js";
import type { SupipowersConfig } from "../types.js";

interface SettingDef {
  label: string;
  key: string;
  type: "select" | "toggle" | "number" | "text";
  options?: string[];
  get: (config: SupipowersConfig) => string;
  set: (cwd: string, value: unknown) => void;
}

function buildSettings(cwd: string): SettingDef[] {
  return [
    {
      label: "Default profile",
      key: "defaultProfile",
      type: "select",
      options: listProfiles(cwd),
      get: (c) => c.defaultProfile,
      set: (d, v) => updateConfig(d, { defaultProfile: v }),
    },
    {
      label: "Max parallel agents",
      key: "orchestration.maxParallelAgents",
      type: "select",
      options: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
      get: (c) => String(c.orchestration.maxParallelAgents),
      set: (d, v) => updateConfig(d, { orchestration: { maxParallelAgents: Number(v) } }),
    },
    {
      label: "Max fix retries",
      key: "orchestration.maxFixRetries",
      type: "select",
      options: ["0", "1", "2", "3", "4", "5"],
      get: (c) => String(c.orchestration.maxFixRetries),
      set: (d, v) => updateConfig(d, { orchestration: { maxFixRetries: Number(v) } }),
    },
    {
      label: "Max nesting depth",
      key: "orchestration.maxNestingDepth",
      type: "select",
      options: ["0", "1", "2", "3", "4", "5"],
      get: (c) => String(c.orchestration.maxNestingDepth),
      set: (d, v) => updateConfig(d, { orchestration: { maxNestingDepth: Number(v) } }),
    },
    {
      label: "Model preference",
      key: "orchestration.modelPreference",
      type: "select",
      options: ["auto", "fast", "balanced", "quality"],
      get: (c) => c.orchestration.modelPreference,
      set: (d, v) => updateConfig(d, { orchestration: { modelPreference: v } }),
    },
    {
      label: "LSP setup guide",
      key: "lsp.setupGuide",
      type: "toggle",
      get: (c) => c.lsp.setupGuide ? "on" : "off",
      set: (d, v) => updateConfig(d, { lsp: { setupGuide: v === "on" } }),
    },
    {
      label: "Notification verbosity",
      key: "notifications.verbosity",
      type: "select",
      options: ["quiet", "normal", "verbose"],
      get: (c) => c.notifications.verbosity,
      set: (d, v) => updateConfig(d, { notifications: { verbosity: v } }),
    },
    {
      label: "QA framework",
      key: "qa.framework",
      type: "text",
      get: (c) => c.qa.framework ?? "not set",
      set: (d, v) => updateConfig(d, { qa: { framework: v || null } }),
    },
    {
      label: "QA command",
      key: "qa.command",
      type: "text",
      get: (c) => c.qa.command ?? "not set",
      set: (d, v) => updateConfig(d, { qa: { command: v || null } }),
    },
    {
      label: "Release pipeline",
      key: "release.pipeline",
      type: "text",
      get: (c) => c.release.pipeline ?? "not set",
      set: (d, v) => updateConfig(d, { release: { pipeline: v || null } }),
    },
  ];
}

export function registerConfigCommand(pi: ExtensionAPI): void {
  pi.registerCommand("supi:config", {
    description: "View and manage Supipowers configuration",
    async handler(_args, ctx) {
      if (!ctx.hasUI) {
        ctx.ui.notify("Config UI requires interactive mode", "warning");
        return;
      }

      ctx.ui.setEditorText("");
      void (async () => {
        const settings = buildSettings(ctx.cwd);

        while (true) {
          const config = loadConfig(ctx.cwd);

          const options = settings.map(
            (s) => `${s.label}: ${s.get(config)}`
          );
          options.push("Done");

          const choice = await ctx.ui.select(
            "Supipowers Settings",
            options,
            { helpText: "Select a setting to change · Esc to close" },
          );

          if (choice === undefined || choice === "Done") break;

          const index = options.indexOf(choice);
          const setting = settings[index];
          if (!setting) break;

          if (setting.type === "select" && setting.options) {
            const value = await ctx.ui.select(
              setting.label,
              setting.options,
              { initialIndex: setting.options.indexOf(setting.get(config)) },
            );
            if (value !== undefined) {
              setting.set(ctx.cwd, value);
              ctx.ui.notify(`${setting.label} → ${value}`, "info");
            }
          } else if (setting.type === "toggle") {
            const current = setting.get(config);
            const newValue = current === "on" ? "off" : "on";
            setting.set(ctx.cwd, newValue);
            ctx.ui.notify(`${setting.label} → ${newValue}`, "info");
          } else if (setting.type === "text") {
            const value = await ctx.ui.input(
              setting.label,
              setting.get(config) === "not set" ? undefined : setting.get(config),
            );
            if (value !== undefined) {
              setting.set(ctx.cwd, value);
              ctx.ui.notify(`${setting.label} → ${value || "cleared"}`, "info");
            }
          }
        }
      })();
    },
  });
}
