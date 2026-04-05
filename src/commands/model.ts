import type { Platform } from "../platform/types.js";
import { modelRegistry } from "../config/model-registry-instance.js";
import {
  loadModelConfig,
  saveModelAssignment,
  getAssignmentSource,
  type AssignmentSource,
} from "../config/model-config.js";
import { resolveModelForAction, createModelBridge, type ModelPlatformBridge } from "../config/model-resolver.js";
import type { ModelAction, ModelAssignment, ThinkingLevel } from "../types.js";
import { getBundledProviders, getBundledModels, type GeneratedProvider } from "@oh-my-pi/pi-ai";
import { createModelPicker, type AvailableModelSet } from "./model-picker.js";

const THINKING_LEVELS: Array<{ label: string; value: ThinkingLevel | null }> = [
  { label: "Inherit (model default)", value: null },
  { label: "Off", value: "off" },
  { label: "Minimal", value: "minimal" },
  { label: "Low", value: "low" },
  { label: "Medium", value: "medium" },
  { label: "High", value: "high" },
  { label: "Extra High", value: "xhigh" },
];

function formatSource(source: AssignmentSource): string {
  switch (source) {
    case "action-project": return "(project)";
    case "action-global": return "(global)";
    case "default-project": return "(default\u00b7project)";
    case "default-global": return "(default\u00b7global)";
    case "harness": return "(harness)";
    case "main": return "(main)";
  }
}

function buildDashboard(
  actions: ModelAction[],
  paths: Platform["paths"],
  cwd: string,
  bridge: ModelPlatformBridge,
): string {
  const config = loadModelConfig(paths, cwd);
  const lines: string[] = ["\n  Model Configuration\n", `  ${"action".padEnd(20)} ${"model".padEnd(24)} ${"thinking".padEnd(10)} source`];

  let lastCategory: "command" | "sub-agent" | null = null;
  let lastParent: string | undefined = undefined;

  for (const action of actions) {
    if (action.category === "sub-agent" && lastCategory !== "sub-agent") {
      lines.push(`  ${"─".repeat(3)} sub-agents (${action.parent ?? "?"}) ${"─".repeat(3)}`);
    } else if (action.category === "sub-agent" && action.parent !== lastParent) {
      lines.push(`  ${"─".repeat(3)} sub-agents (${action.parent ?? "?"}) ${"─".repeat(3)}`);
    }

    const resolved = resolveModelForAction(action.id, modelRegistry, config, bridge);
    const source = getAssignmentSource(paths, cwd, action.id);
    const modelDisplay = (resolved.source === "main" && source === "main"
      ? "—"
      : resolved.model) ?? "—";
    const thinkingDisplay = resolved.thinkingLevel ?? "—";
    const sourceDisplay = formatSource(source);

    lines.push(
      `  ${action.id.padEnd(20)} ${modelDisplay.padEnd(24)} ${thinkingDisplay.padEnd(10)} ${sourceDisplay}`,
    );

    lastCategory = action.category;
    lastParent = action.parent;
  }

  lines.push("");
  return lines.join("\n");
}

export function handleModel(platform: Platform, ctx: any): void {
  if (!ctx.hasUI) {
    ctx.ui.notify("Model configuration requires interactive mode", "warning");
    return;
  }

  runModelTUI(platform, ctx).catch((err: Error) => {
    ctx.ui.notify(`Model config error: ${err.message}`, "error");
  });
}

async function runModelTUI(platform: Platform, ctx: any): Promise<void> {
  const bridge = createModelBridge(platform);

  while (true) {
    const actions = modelRegistry.list();
    const dashboard = buildDashboard(actions, platform.paths, ctx.cwd, bridge);

    // Build menu options
    const menuOptions = [
      ...actions.map((a: ModelAction) => a.id),
      "── Global default ──",
      "Clear assignment",
      "Reset all",
    ];

    ctx.ui.notify(dashboard, "info");

    const choice = await ctx.ui.select("Configure action", menuOptions, {
      helpText: "Select action to configure · Esc to exit",
    });

    if (!choice) return; // Escape pressed

    if (choice === "Clear assignment") {
      // Pick which action to clear
      const clearOptions = [
        ...actions.map((a: ModelAction) => a.id),
        "── Global default ──",
      ];
      const clearChoice = await ctx.ui.select("Clear which action?", clearOptions, {
        helpText: "Select action to clear · Esc to cancel",
      });
      if (!clearChoice) continue;
      const clearIsDefault = clearChoice === "── Global default ──";
      const clearActionId = clearIsDefault ? null : clearChoice;
      const scope = await selectScope(ctx);
      if (!scope) continue;
      saveModelAssignment(platform.paths, ctx.cwd, scope, clearActionId, null);
      ctx.ui.notify(
        `Cleared ${clearIsDefault ? "default" : clearActionId} (${scope})`,
        "info",
      );
      continue;
    }

    if (choice === "Reset all") {
      const confirm = ctx.ui.confirm
        ? await ctx.ui.confirm("Reset all", "Clear all model assignments?")
        : true;
      if (confirm) {
        saveModelAssignment(platform.paths, ctx.cwd, "project", null, null);
        const config = loadModelConfig(platform.paths, ctx.cwd);
        for (const actionId of Object.keys(config.actions)) {
          saveModelAssignment(platform.paths, ctx.cwd, "project", actionId, null);
        }
        ctx.ui.notify("All model assignments cleared (project scope)", "info");
      }
      continue;
    }

    const isDefault = choice === "── Global default ──";
    const actionId = isDefault ? null : choice;

    // Step 2: Model selection (provider → model picker)
    const config = loadModelConfig(platform.paths, ctx.cwd);
    const currentModel = isDefault
      ? config.default?.model
      : actionId ? config.actions[actionId]?.model : undefined;

    const modelInput = await selectModelFromList(ctx, currentModel);

    if (modelInput === null) continue; // cancelled

    // Step 3: Thinking level
    const thinkingChoice = await ctx.ui.select(
      "Thinking level",
      THINKING_LEVELS.map((t) => t.label),
      { helpText: "Select thinking level · Esc to cancel" },
    );
    if (!thinkingChoice) continue;
    const thinkingLevel = THINKING_LEVELS.find((t) => t.label === thinkingChoice)?.value ?? null;

    // Step 4: Scope
    const scope = await selectScope(ctx);
    if (!scope) continue;

    const assignment: ModelAssignment = {
      model: modelInput,
      thinkingLevel,
    };

    saveModelAssignment(platform.paths, ctx.cwd, scope, actionId, assignment);
    ctx.ui.notify(
      `${isDefault ? "Default" : actionId}: ${modelInput} (${scope})`,
      "info",
    );
  }
}

async function selectModelFromList(
  ctx: any,
  currentModel?: string,
): Promise<string | null> {
  // Use custom TUI picker if available (OMP with interactive mode)
  if (typeof ctx.ui.custom === "function") {
    // ctx.modelRegistry is the live OMP ModelRegistry instance —
    // getAvailable() filters by OAuth + env vars + stored creds
    let available: AvailableModelSet | undefined;
    try {
      const models = ctx.modelRegistry?.getAvailable?.() ?? [];
      if (models.length > 0) {
        available = {
          providers: new Set(models.map((m: any) => String(m.provider))),
          modelIds: new Set(models.map((m: any) => `${m.provider}/${m.id}`)),
        };
      }
    } catch {
      // Fall through — picker will show all models unfiltered
    }
    return ctx.ui.custom((tui: any, theme: any, kb: any, done: any) =>
      createModelPicker(tui, theme, kb, done, available),
    );
  }

  // Fallback: flat select list for non-OMP platforms
  const providers = getBundledProviders();
  const allModels: string[] = [];
  for (const provider of providers.sort()) {
    const models = getBundledModels(provider as GeneratedProvider);
    for (const m of models) {
      allModels.push(`${provider}/${m.id}`);
    }
  }
  allModels.sort();

  const choice = await ctx.ui.select(
    currentModel ? `Model (current: ${currentModel})` : "Model",
    allModels,
    { helpText: "Type to filter · Esc to cancel" },
  );

  if (!choice) return null;
  const slashIndex = choice.indexOf("/");
  return slashIndex >= 0 ? choice.slice(slashIndex + 1) : choice;
}

async function selectScope(ctx: any): Promise<"global" | "project" | null> {
  const scopeChoice = await ctx.ui.select("Save to", [
    "This project",
    "Global",
  ], { helpText: "Where to persist this setting" });

  if (!scopeChoice) return null;
  return scopeChoice === "Global" ? "global" : "project";
}

export function registerModelCommand(platform: Platform): void {
  platform.registerCommand("supi:model", {
    description: "Configure model assignments per action",
    async handler(_args: string | undefined, ctx: any) {
      handleModel(platform, ctx);
    },
  });
}
