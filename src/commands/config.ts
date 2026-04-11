import type { Platform, PlatformContext } from "../platform/types.js";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import { formatConfigErrors, inspectConfig, updateConfig } from "../config/loader.js";
import { checkInstallation } from "../context-mode/installer.js";
import type { InspectionLoadResult } from "../config/schema.js";
import type { SupipowersConfig } from "../types.js";
import { createWorkflowProgress } from "../platform/progress.js";
import {
  interactivelySaveGateSetup,
  setupGates,
  summarizeEnabledGates,
  type GateSetupMode,
  type SetupGatesProgressEvent,
} from "../quality/setup.js";

const FRAMEWORK_OPTIONS = [
  { value: "", label: "not set — auto-detect on first /supi:qa run" },
  { value: "vitest", label: "vitest — npx vitest run" },
  { value: "jest", label: "jest — npx jest" },
  { value: "mocha", label: "mocha — npx mocha" },
  { value: "pytest", label: "pytest — pytest" },
  { value: "cargo-test", label: "cargo-test — cargo test" },
  { value: "go-test", label: "go-test — go test ./..." },
  { value: "npm-test", label: "npm-test — npm test" },
];

const CHANNEL_OPTIONS = [
  { value: [] as string[], label: "not set — auto-detect on first /supi:release run" },
  { value: ["github", "npm"], label: "both — GitHub Release + npm publish" },
  { value: ["github"], label: "github — GitHub Release with gh CLI" },
  { value: ["npm"], label: "npm — npm publish to registry" },
];

export interface SettingDef {
  label: string;
  key: string;
  helpText: string;
  type: "select" | "toggle";
  options?: string[];
  get: () => string;
  set: (cwd: string, value: unknown) => Promise<string | null>;
}

export interface ConfigCommandDependencies {
  inspectConfig: typeof inspectConfig;
  updateConfig: typeof updateConfig;
  setupGates: typeof setupGates;
  interactivelySaveGateSetup: typeof interactivelySaveGateSetup;
  checkInstallation: typeof checkInstallation;
}

const CONFIG_COMMAND_DEPENDENCIES: ConfigCommandDependencies = {
  inspectConfig,
  updateConfig,
  setupGates,
  interactivelySaveGateSetup,
  checkInstallation,
};

function currentConfig(inspection: InspectionLoadResult): SupipowersConfig {
  return inspection.effectiveConfig ?? DEFAULT_CONFIG;
}

function describeInspection(inspection: InspectionLoadResult, config: SupipowersConfig): string {
  if (inspection.parseErrors.length > 0 || inspection.validationErrors.length > 0) {
    return `config error — ${formatConfigErrors(inspection).split("\n")[0]}`;
  }

  return summarizeEnabledGates(config.quality.gates);
}

function createQualityGateSetupProgress(ctx: PlatformContext, mode: GateSetupMode) {
  if (mode !== "ai-assisted") {
    return null;
  }

  const progress = createWorkflowProgress(ctx.ui, {
    title: "quality gate setup",
    statusKey: "supi-quality-gate-setup",
    widgetKey: "supi-quality-gate-setup",
    steps: [
      { key: "collect", label: "Inspect project" },
      { key: "ai", label: "AI analysis" },
    ],
  });

  return {
    handle(event: SetupGatesProgressEvent) {
      switch (event.type) {
        case "collecting-project-facts":
          progress.activate("collect", "Reading scripts and tools");
          return;
        case "baseline-ready":
          progress.complete("collect", "baseline ready");
          return;
        case "ai-analysis-started":
          progress.activate("ai", "Analyzing project checks");
          return;
        case "ai-analysis-completed":
          progress.complete("ai", "proposal ready");
          return;
      }
    },
    fail(message: string) {
      if (progress.getStatus("ai") === "active") {
        progress.fail("ai", message);
      } else if (progress.getStatus("collect") === "active") {
        progress.fail("collect", message);
      }
    },
    dispose() {
      progress.dispose();
    },
  };
}

function buildGateSetupDialogOptions(mode: GateSetupMode) {
  return mode === "ai-assisted"
    ? {
        title: "AI-assisted quality gate proposal",
        intro: "AI analyzed your project and suggested these gates.",
      }
    : {
        intro: "Detected project checks and suggested these gates.",
      };
}

export function buildSettings(
  platform: Platform,
  ctx: PlatformContext,
  inspection: InspectionLoadResult,
  deps: ConfigCommandDependencies = CONFIG_COMMAND_DEPENDENCIES,
): SettingDef[] {
  const { paths } = platform;
  const config = currentConfig(inspection);

  return [
    {
      label: "Setup quality gates",
      key: "quality.gates",
      helpText: "Inspect the project and configure review gates",
      type: "select",
      options: ["Run deterministic setup", "Run AI-assisted setup"],
      get: () => describeInspection(inspection, config),
      set: async (cwd, value) => {
        const mode: GateSetupMode = String(value).includes("AI-assisted") ? "ai-assisted" : "deterministic";
        const progress = createQualityGateSetupProgress(ctx, mode);

        try {
          const result = await deps.setupGates(platform, cwd, deps.inspectConfig(platform.paths, cwd), {
            mode,
            onProgress: (event) => progress?.handle(event),
          });

          if (result.status === "invalid") {
            ctx.ui.notify(result.errors.join("\n"), "error");
            return null;
          }

          if (result.status !== "proposed") {
            return null;
          }

          progress?.dispose();
          const saveResult = await deps.interactivelySaveGateSetup(
            ctx,
            paths,
            cwd,
            result.proposal,
            buildGateSetupDialogOptions(mode),
          );
          return saveResult === "saved" ? "saved" : null;
        } catch (error) {
          progress?.fail((error as Error).message);
          throw error;
        } finally {
          progress?.dispose();
        }
      },
    },
    {
      label: "LSP setup guide",
      key: "lsp.setupGuide",
      helpText: "Show LSP setup tips when no language server is active",
      type: "toggle",
      get: () => (config.lsp.setupGuide ? "on" : "off"),
      set: async (cwd, value) => {
        deps.updateConfig(paths, cwd, { lsp: { setupGuide: value === "on" } });
        return String(value);
      },
    },
    {
      label: "Notification verbosity",
      key: "notifications.verbosity",
      helpText: "How much detail supipowers shows in notifications",
      type: "select",
      options: ["quiet", "normal", "verbose"],
      get: () => config.notifications.verbosity,
      set: async (cwd, value) => {
        deps.updateConfig(paths, cwd, { notifications: { verbosity: value } });
        return String(value);
      },
    },
    {
      label: "QA framework",
      key: "qa.framework",
      helpText: "Test runner used by /supi:qa",
      type: "select",
      options: FRAMEWORK_OPTIONS.map((framework) => framework.label),
      get: () => config.qa.framework ?? "not set",
      set: async (cwd, value) => {
        const chosen = FRAMEWORK_OPTIONS.find((framework) => framework.label === value);
        if (!chosen) {
          return null;
        }

        deps.updateConfig(paths, cwd, { qa: { framework: chosen.value || null } });
        return chosen.label.split(" — ")[0];
      },
    },
    {
      label: "Release channels",
      key: "release.channels",
      helpText: "Where /supi:release publishes your project",
      type: "select",
      options: CHANNEL_OPTIONS.map((channel) => channel.label),
      get: () =>
        config.release.channels.length > 0 ? config.release.channels.join(", ") : "not set",
      set: async (cwd, value) => {
        const chosen = CHANNEL_OPTIONS.find((channel) => channel.label === value);
        if (!chosen) {
          return null;
        }

        deps.updateConfig(paths, cwd, { release: { channels: chosen.value } });
        return chosen.label.split(" — ")[0];
      },
    },
  ];
}

export async function runConfigMenu(
  platform: Platform,
  ctx: PlatformContext,
  deps: ConfigCommandDependencies = CONFIG_COMMAND_DEPENDENCIES,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Config UI requires interactive mode", "warning");
    return;
  }

  while (true) {
    const inspection = deps.inspectConfig(platform.paths, ctx.cwd);
    const settings = buildSettings(platform, ctx, inspection, deps);
    const options = settings.map((setting) => `${setting.label}: ${setting.get()}`);
    options.push("Done");

    const choice = await ctx.ui.select(
      "Supipowers Settings",
      options,
      { helpText: "Select a setting to change · Esc to close" },
    );

    if (choice === undefined || choice === null || choice === "Done") {
      break;
    }

    const index = options.indexOf(choice);
    const setting = settings[index];
    if (!setting) {
      break;
    }

    try {
      if (setting.type === "select" && setting.options) {
        const currentValue = setting.get();
        const currentIndex = setting.options.findIndex((option) => option.startsWith(currentValue));
        const value = await ctx.ui.select(
          setting.label,
          setting.options,
          {
            initialIndex: Math.max(0, currentIndex),
            helpText: setting.helpText,
          },
        );

        if (value !== undefined && value !== null) {
          const display = await setting.set(ctx.cwd, value);
          if (display) {
            ctx.ui.notify(`${setting.label} → ${display}`, "info");
          }
        }
      } else if (setting.type === "toggle") {
        const current = setting.get();
        const newValue = current === "on" ? "off" : "on";
        const display = await setting.set(ctx.cwd, newValue);
        if (display) {
          ctx.ui.notify(`${setting.label} → ${display}`, "info");
        }
      }
    } catch (error) {
      ctx.ui.notify((error as Error).message, "error");
    }
  }
}

export function handleConfig(platform: Platform, ctx: PlatformContext): void {
  void runConfigMenu(platform, ctx, CONFIG_COMMAND_DEPENDENCIES);

  void CONFIG_COMMAND_DEPENDENCIES.checkInstallation(
    (cmd: string, args: string[]) => platform.exec(cmd, args),
    platform.getActiveTools(),
  )
    .then((status) => {
      const lines = [
        "",
        "Context Mode:",
        `  CLI installed: ${status.cliInstalled ? "✓" + (status.version ? ` v${status.version}` : "") : "✗"}`,
        `  MCP configured: ${status.mcpConfigured ? "✓" : "✗"}`,
        `  Tools available: ${status.toolsAvailable ? "✓" : "✗"}`,
      ];
      if (!status.mcpConfigured && status.cliInstalled) {
        lines.push(`  → Run \`${platform.name} mcp add context-mode\` to enable`);
      }
      ctx.ui.notify(lines.join("\n"), "info");
    })
    .catch(() => {
      // Silently ignore — context-mode status is optional.
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
