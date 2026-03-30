import type { Platform, PlatformContext } from "../platform/types.js";
import { loadConfig, updateConfig } from "../config/loader.js";
import { listProfiles } from "../config/profiles.js";
import { checkInstallation } from "../context-mode/installer.js";
import type { SupipowersConfig } from "../types.js";

const FRAMEWORK_OPTIONS = [
  { value: "", label: "not set — auto-detect on first /supi:qa run", command: null },
  { value: "vitest", label: "vitest — npx vitest run", command: "npx vitest run" },
  { value: "jest", label: "jest — npx jest", command: "npx jest" },
  { value: "mocha", label: "mocha — npx mocha", command: "npx mocha" },
  { value: "pytest", label: "pytest — pytest", command: "pytest" },
  { value: "cargo-test", label: "cargo-test — cargo test", command: "cargo test" },
  { value: "go-test", label: "go-test — go test ./...", command: "go test ./..." },
  { value: "npm-test", label: "npm-test — npm test", command: "npm test" },
];

const CHANNEL_OPTIONS = [
  { value: [] as string[], label: "not set — auto-detect on first /supi:release run" },
  { value: ["github", "npm"], label: "both — GitHub Release + npm publish" },
  { value: ["github"], label: "github — GitHub Release with gh CLI" },
  { value: ["npm"], label: "npm — npm publish to registry" },
];

interface SettingDef {
  label: string;
  key: string;
  helpText: string;
  type: "select" | "toggle";
  options?: string[];
  get: (config: SupipowersConfig) => string;
  set: (cwd: string, value: unknown) => void;
}

function buildSettings(platform: Platform, cwd: string): SettingDef[] {
  const { paths } = platform;
  return [
    {
      label: "Default profile",
      key: "defaultProfile",
      helpText: "Review depth used when no flag is passed to /supi:review",
      type: "select",
      options: listProfiles(paths, cwd),
      get: (c) => c.defaultProfile,
      set: (d, v) => updateConfig(paths, d, { defaultProfile: v }),
    },
    {
      label: "Max parallel agents",
      key: "orchestration.maxParallelAgents",
      helpText: "Sub-agents running concurrently in each /supi:run batch",
      type: "select",
      options: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
      get: (c) => String(c.orchestration.maxParallelAgents),
      set: (d, v) => updateConfig(paths, d, { orchestration: { maxParallelAgents: Number(v) } }),
    },
    {
      label: "Max fix retries",
      key: "orchestration.maxFixRetries",
      helpText: "Times a failed task is retried before marking it blocked",
      type: "select",
      options: ["0", "1", "2", "3", "4", "5"],
      get: (c) => String(c.orchestration.maxFixRetries),
      set: (d, v) => updateConfig(paths, d, { orchestration: { maxFixRetries: Number(v) } }),
    },
    {
      label: "Max nesting depth",
      key: "orchestration.maxNestingDepth",
      helpText: "How deep sub-agents can spawn other sub-agents",
      type: "select",
      options: ["0", "1", "2", "3", "4", "5"],
      get: (c) => String(c.orchestration.maxNestingDepth),
      set: (d, v) => updateConfig(paths, d, { orchestration: { maxNestingDepth: Number(v) } }),
    },
    {
      label: "LSP setup guide",
      key: "lsp.setupGuide",
      helpText: "Show LSP setup tips when no language server is active",
      type: "toggle",
      get: (c) => c.lsp.setupGuide ? "on" : "off",
      set: (d, v) => updateConfig(paths, d, { lsp: { setupGuide: v === "on" } }),
    },
    {
      label: "Notification verbosity",
      key: "notifications.verbosity",
      helpText: "How much detail supipowers shows in notifications",
      type: "select",
      options: ["quiet", "normal", "verbose"],
      get: (c) => c.notifications.verbosity,
      set: (d, v) => updateConfig(paths, d, { notifications: { verbosity: v } }),
    },
    {
      label: "QA framework",
      key: "qa.framework",
      helpText: "Test runner used by /supi:qa",
      type: "select",
      options: FRAMEWORK_OPTIONS.map((f) => f.label),
      get: (c) => c.qa.framework ?? "not set",
      set: (d, v) => {
        const chosen = FRAMEWORK_OPTIONS.find((f) => f.label === v);
        if (chosen) {
          updateConfig(paths, d, { qa: { framework: chosen.value || null, command: chosen.command } });
        }
      },
    },
    {
      label: "Release channels",
      key: "release.channels",
      helpText: "Where /supi:release publishes your project",
      type: "select",
      options: CHANNEL_OPTIONS.map((p) => p.label),
      get: (c) => c.release.channels.length > 0 ? c.release.channels.join(", ") : "not set",
      set: (d, v) => {
        const chosen = CHANNEL_OPTIONS.find((p) => p.label === v);
        if (chosen) {
          updateConfig(paths, d, { release: { channels: chosen.value } });
        }
      },
    },
  ];
}

export function handleConfig(platform: Platform, ctx: PlatformContext): void {
  if (!ctx.hasUI) {
    ctx.ui.notify("Config UI requires interactive mode", "warning");
    return;
  }

  void (async () => {
    const settings = buildSettings(platform, ctx.cwd);

    while (true) {
      const config = loadConfig(platform.paths, ctx.cwd);

      const options = settings.map(
        (s) => `${s.label}: ${s.get(config)}`
      );
      options.push("Done");

      const choice = await ctx.ui.select(
        "Supipowers Settings",
        options,
        { helpText: "Select a setting to change · Esc to close" },
      );

      if (choice === undefined || choice === null || choice === "Done") break;

      const index = options.indexOf(choice);
      const setting = settings[index];
      if (!setting) break;

      if (setting.type === "select" && setting.options) {
        const currentValue = setting.get(config);
        const currentIndex = setting.options.findIndex((o) => o.startsWith(currentValue));
        const value = await ctx.ui.select(
          setting.label,
          setting.options,
          {
            initialIndex: Math.max(0, currentIndex),
            helpText: setting.helpText,
          },
        );
        if (value !== undefined && value !== null) {
          setting.set(ctx.cwd, value);
          const display = value.split(" — ")[0];
          ctx.ui.notify(`${setting.label} → ${display}`, "info");
        }
      } else if (setting.type === "toggle") {
        const current = setting.get(config);
        const newValue = current === "on" ? "off" : "on";
        setting.set(ctx.cwd, newValue);
        ctx.ui.notify(`${setting.label} → ${newValue}`, "info");
      }
    }
  })();

  // Context-mode status (async, fire-and-forget)
  checkInstallation(
    (cmd: string, args: string[]) => platform.exec(cmd, args),
    platform.getActiveTools(),
  ).then((status) => {
    const lines = [
      "",
      "Context Mode:",
      `  CLI installed: ${status.cliInstalled ? "\u2713" + (status.version ? ` v${status.version}` : "") : "\u2717"}`,
      `  MCP configured: ${status.mcpConfigured ? "\u2713" : "\u2717"}`,
      `  Tools available: ${status.toolsAvailable ? "\u2713" : "\u2717"}`,
    ];
    if (!status.mcpConfigured && status.cliInstalled) {
      lines.push(`  \u2192 Run \`${platform.name} mcp add context-mode\` to enable`);
    }
    ctx.ui.notify(lines.join("\n"), "info");
  }).catch(() => {
    // Silently ignore — context-mode status is optional
  });
}

export function registerConfigCommand(platform: Platform): void {
  platform.registerCommand("supi:config", {
    description: "View and manage Supipowers configuration",
    async handler(_args: string | undefined, ctx: any) {
      handleConfig(platform, ctx);
    },
  });
}
