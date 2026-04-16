import { isDeepStrictEqual } from "node:util";
import type { Platform, PlatformContext } from "../platform/types.js";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import { formatConfigErrors, inspectConfig, updateConfig } from "../config/loader.js";
import type { InspectionLoadResult } from "../config/schema.js";
import { validateQualityGates } from "../config/schema.js";
import { createWorkflowProgress } from "../platform/progress.js";
import {
  setupGates,
  summarizeEnabledGates,
  type GateSetupMode,
  type SetupGatesProgressEvent,
} from "../quality/setup.js";
import type { ConfigScope, QualityGatesConfig, SupipowersConfig, WorkspaceTarget } from "../types.js";
import { resolvePackageManager } from "../workspace/package-manager.js";
import {
  buildWorkspaceTargetOptionLabel,
  selectWorkspaceTarget,
  type WorkspaceTargetOption,
} from "../workspace/selector.js";
import { findWorkspaceTargetForPath } from "../workspace/path-mapping.js";
import { discoverWorkspaceTargets, toWorkspaceRelativeDir } from "../workspace/targets.js";

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
  { value: ["github"], label: "github — GitHub Release with gh CLI" },
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

export interface ConfigScopeSelection {
  scope: ConfigScope;
  repoRoot: string;
  workspaceTarget: WorkspaceTarget | null;
}

export interface ConfigScopeView {
  selection: ConfigScopeSelection;
  inspection: InspectionLoadResult;
  globalInspection: InspectionLoadResult;
  rootInspection: InspectionLoadResult;
  workspaceInspection: InspectionLoadResult | null;
}

export interface ConfigCommandDependencies {
  inspectConfig: typeof inspectConfig;
  updateConfig: typeof updateConfig;
  setupGates: typeof setupGates;
}

const CONFIG_COMMAND_DEPENDENCIES: ConfigCommandDependencies = {
  inspectConfig,
  updateConfig,
  setupGates,
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

function getConfigResolutionOptions(selection: ConfigScopeSelection): {
  repoRoot: string;
  workspaceRelativeDir: string | null;
} {
  return {
    repoRoot: selection.repoRoot,
    workspaceRelativeDir: selection.workspaceTarget?.relativeDir ?? null,
  };
}

function getConfigMutationOptions(selection: ConfigScopeSelection): {
  scope: ConfigScope;
  repoRoot: string;
  workspaceRelativeDir: string | null;
} {
  return {
    scope: selection.scope,
    ...getConfigResolutionOptions(selection),
  };
}

function getSelectionCwd(selection: ConfigScopeSelection): string {
  return selection.workspaceTarget?.packageDir ?? selection.repoRoot;
}

function configPathForSelection(selection: ConfigScopeSelection): string {
  switch (selection.scope) {
    case "global":
      return "~/.omp/supipowers/config.json";
    case "root":
      return ".omp/supipowers/config.json";
    case "workspace":
      if (!selection.workspaceTarget) {
        throw new Error("Workspace config scope requires a workspace target.");
      }
      return `.omp/supipowers/workspaces/${selection.workspaceTarget.relativeDir}/config.json`;
  }
}

function scopeLabel(scope: ConfigScope): string {
  switch (scope) {
    case "global":
      return "global";
    case "root":
      return "root";
    case "workspace":
      return "workspace";
  }
}

function selectionSummary(selection: ConfigScopeSelection): string {
  if (selection.scope !== "workspace") {
    return `${scopeLabel(selection.scope)} — ${configPathForSelection(selection)}`;
  }

  if (!selection.workspaceTarget) {
    return "workspace — target required";
  }

  return [
    "workspace",
    selection.workspaceTarget.name,
    selection.workspaceTarget.relativeDir,
    configPathForSelection(selection),
  ].join(" — ");
}

function getNestedValue(value: unknown, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>((current, segment) => {
      if (!current || typeof current !== "object" || Array.isArray(current)) {
        return undefined;
      }
      return (current as Record<string, unknown>)[segment];
    }, value);
}

function getSelectedConfig(view: ConfigScopeView): SupipowersConfig {
  return currentConfig(view.inspection);
}

function describeSettingProvenance(view: ConfigScopeView, key: string): string {
  const defaultValue = getNestedValue(DEFAULT_CONFIG, key);
  const globalValue = getNestedValue(currentConfig(view.globalInspection), key);
  const rootValue = getNestedValue(currentConfig(view.rootInspection), key);
  const workspaceValue = view.workspaceInspection
    ? getNestedValue(currentConfig(view.workspaceInspection), key)
    : rootValue;

  switch (view.selection.scope) {
    case "global":
      return isDeepStrictEqual(globalValue, defaultValue) ? "default" : "overridden in global";
    case "root":
      if (!isDeepStrictEqual(rootValue, globalValue)) {
        return "overridden in root";
      }
      if (!isDeepStrictEqual(globalValue, defaultValue)) {
        return "inherited from global";
      }
      return "default";
    case "workspace":
      if (!isDeepStrictEqual(workspaceValue, rootValue)) {
        return "overridden in workspace";
      }
      if (!isDeepStrictEqual(rootValue, globalValue)) {
        return "inherited from root";
      }
      if (!isDeepStrictEqual(globalValue, defaultValue)) {
        return "inherited from global";
      }
      return "default";
  }
}

function describeSettingValue(display: string, view: ConfigScopeView, key: string): string {
  return `${display} — ${describeSettingProvenance(view, key)}`;
}

function parseRevisedQualityGates(raw: string): QualityGatesConfig {
  const parsed = JSON.parse(raw) as unknown;
  const validation = validateQualityGates(parsed);
  if (!validation.valid) {
    throw new Error(validation.errors.join("\n"));
  }

  return parsed as QualityGatesConfig;
}

function buildQualityGateSetupHelpText(
  proposal: QualityGatesConfig,
  scopeSelection: ConfigScopeSelection,
  mode: GateSetupMode,
): string {
  const intro = mode === "ai-assisted"
    ? "AI analyzed your project and suggested these gates."
    : "Detected project checks and suggested these gates.";

  return [
    intro,
    "",
    JSON.stringify(proposal, null, 2),
    "",
    `Will write to ${configPathForSelection(scopeSelection)}`,
  ].join("\n");
}

async function saveQualityGateProposal(
  ctx: PlatformContext,
  paths: Platform["paths"],
  deps: ConfigCommandDependencies,
  selection: ConfigScopeSelection,
  proposal: QualityGatesConfig,
  mode: GateSetupMode,
): Promise<"saved" | "cancelled"> {
  let nextProposal = proposal;
  const selectionCwd = getSelectionCwd(selection);
  const mutationOptions = getConfigMutationOptions(selection);

  while (true) {
    const choice = await ctx.ui.select(
      mode === "ai-assisted" ? "AI-assisted quality gate proposal" : "Quality gate setup",
      ["Accept", "Revise", "Cancel"],
      {
        helpText: buildQualityGateSetupHelpText(nextProposal, selection, mode),
      },
    );

    if (!choice || choice === "Cancel") {
      return "cancelled";
    }

    if (choice === "Revise") {
      const revised = await ctx.ui.input(
        "Edit quality.gates JSON",
        { value: JSON.stringify(nextProposal, null, 2) },
      );
      if (!revised) {
        continue;
      }

      try {
        nextProposal = parseRevisedQualityGates(revised);
      } catch (error) {
        ctx.ui.notify((error as Error).message, "error");
      }
      continue;
    }

    deps.updateConfig(paths, selectionCwd, { quality: { gates: nextProposal } }, mutationOptions);
    return "saved";
  }
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

export function buildConfigScopeView(
  platform: Platform,
  cwd: string,
  selection: ConfigScopeSelection,
  deps: Pick<ConfigCommandDependencies, "inspectConfig"> = CONFIG_COMMAND_DEPENDENCIES,
): ConfigScopeView {
  const resolutionOptions = getConfigResolutionOptions(selection);
  const globalInspection = deps.inspectConfig(platform.paths, cwd, { repoRoot: selection.repoRoot, workspaceRelativeDir: null });
  const rootInspection = deps.inspectConfig(platform.paths, cwd, { repoRoot: selection.repoRoot, workspaceRelativeDir: null });
  const workspaceInspection = selection.workspaceTarget
    ? deps.inspectConfig(platform.paths, cwd, resolutionOptions)
    : null;
  const inspection = selection.scope === "global"
    ? globalInspection
    : selection.scope === "root"
      ? rootInspection
      : workspaceInspection ?? rootInspection;

  return {
    selection,
    inspection,
    globalInspection,
    rootInspection,
    workspaceInspection,
  };
}

export function buildSettings(
  platform: Platform,
  ctx: PlatformContext,
  view: ConfigScopeView,
  deps: ConfigCommandDependencies = CONFIG_COMMAND_DEPENDENCIES,
): SettingDef[] {
  const { paths } = platform;
  const config = getSelectedConfig(view);
  const selectionCwd = getSelectionCwd(view.selection);
  const resolutionOptions = getConfigResolutionOptions(view.selection);
  const mutationOptions = getConfigMutationOptions(view.selection);

  return [
    {
      label: "Setup quality gates",
      key: "quality.gates",
      helpText: `Inspect the project and configure review gates. Changes write to ${configPathForSelection(view.selection)}.`,
      type: "select",
      options: ["Run deterministic setup", "Run AI-assisted setup"],
      get: () => describeSettingValue(describeInspection(view.inspection, config), view, "quality.gates"),
      set: async (_cwd, value) => {
        const mode: GateSetupMode = String(value).includes("AI-assisted") ? "ai-assisted" : "deterministic";
        const progress = createQualityGateSetupProgress(ctx, mode);

        try {
          const selectedInspection = deps.inspectConfig(paths, selectionCwd, resolutionOptions);
          const result = await deps.setupGates(platform, selectionCwd, selectedInspection, {
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
          const saveResult = await saveQualityGateProposal(
            ctx,
            paths,
            deps,
            view.selection,
            result.proposal.gates,
            mode,
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
      helpText: `Show LSP setup tips when no language server is active. Changes write to ${configPathForSelection(view.selection)}.`,
      type: "toggle",
      get: () => describeSettingValue(config.lsp.setupGuide ? "on" : "off", view, "lsp.setupGuide"),
      set: async (_cwd, value) => {
        deps.updateConfig(paths, selectionCwd, { lsp: { setupGuide: value === "on" } }, mutationOptions);
        return String(value);
      },
    },
    {
      label: "QA framework",
      key: "qa.framework",
      helpText: `Test runner used by /supi:qa. Changes write to ${configPathForSelection(view.selection)}.`,
      type: "select",
      options: FRAMEWORK_OPTIONS.map((framework) => framework.label),
      get: () => describeSettingValue(config.qa.framework ?? "not set", view, "qa.framework"),
      set: async (_cwd, value) => {
        const chosen = FRAMEWORK_OPTIONS.find((framework) => framework.label === value);
        if (!chosen) {
          return null;
        }

        deps.updateConfig(paths, selectionCwd, { qa: { framework: chosen.value || null } }, mutationOptions);
        return chosen.label.split(" — ")[0];
      },
    },
    {
      label: "Release channels",
      key: "release.channels",
      helpText: `Where /supi:release publishes your project. Changes write to ${configPathForSelection(view.selection)}.`,
      type: "select",
      options: CHANNEL_OPTIONS.map((channel) => channel.label),
      get: () => describeSettingValue(
        config.release.channels.length > 0 ? config.release.channels.join(", ") : "not set",
        view,
        "release.channels",
      ),
      set: async (_cwd, value) => {
        const chosen = CHANNEL_OPTIONS.find((channel) => channel.label === value);
        if (!chosen) {
          return null;
        }

        deps.updateConfig(paths, selectionCwd, { release: { channels: chosen.value } }, mutationOptions);
        return chosen.label.split(" — ")[0];
      },
    },
  ];
}

async function resolveRepoRoot(platform: Platform, cwd: string): Promise<string> {
  try {
    const result = await platform.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
    if (result.code === 0) {
      const repoRoot = result.stdout.trim();
      if (repoRoot.length > 0) {
        return repoRoot;
      }
    }
  } catch {
    // Fall back to cwd when not inside a git worktree.
  }

  return cwd;
}

async function selectConfigScope(
  ctx: PlatformContext,
  selection: ConfigScopeSelection,
  workspaceTargets: WorkspaceTarget[],
): Promise<ConfigScopeSelection | null> {
  const workspaceOptions = workspaceTargets
    .filter((target) => target.kind === "workspace")
    .map((target) => ({
      target,
      changed: false,
      label: buildWorkspaceTargetOptionLabel(
        { target, changed: false } satisfies WorkspaceTargetOption,
        target.id === selection.workspaceTarget?.id ? ["current"] : [],
      ),
    }));
  const scopeChoices = [
    `Global — ${configPathForSelection({ ...selection, scope: "global" })}`,
    `Root — ${configPathForSelection({ ...selection, scope: "root" })}`,
    ...(workspaceOptions.length > 0 ? ["Workspace — select target"] : []),
    "Cancel",
  ];

  const choice = await ctx.ui.select("Config scope", scopeChoices, {
    helpText: "Choose which config layer to inspect and edit.",
  });
  if (!choice || choice === "Cancel") {
    return null;
  }

  if (choice.startsWith("Global")) {
    return { ...selection, scope: "global" };
  }

  if (choice.startsWith("Root")) {
    return { ...selection, scope: "root" };
  }

  const workspaceTarget = await selectWorkspaceTarget(ctx, workspaceOptions, null, {
    title: "Workspace config target",
    helpText: "Pick one workspace whose config scope should be edited.",
  });
  if (!workspaceTarget) {
    return null;
  }

  return {
    ...selection,
    scope: "workspace",
    workspaceTarget,
  };
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

  const repoRoot = await resolveRepoRoot(platform, ctx.cwd);
  const workspaceTargets = discoverWorkspaceTargets(repoRoot, resolvePackageManager(repoRoot).id);
  const inferredTarget = workspaceTargets.length > 0
    ? findWorkspaceTargetForPath(workspaceTargets, toWorkspaceRelativeDir(repoRoot, ctx.cwd))
    : null;
  let selection: ConfigScopeSelection = {
    scope: inferredTarget?.kind === "workspace" ? "workspace" : "root",
    repoRoot,
    workspaceTarget: inferredTarget?.kind === "workspace" ? inferredTarget : null,
  };

  while (true) {
    const view = buildConfigScopeView(platform, ctx.cwd, selection, deps);
    const settings = buildSettings(platform, ctx, view, deps);
    const scopeChoice = `Config scope: ${selectionSummary(selection)}`;
    const options = [scopeChoice, ...settings.map((setting) => `${setting.label}: ${setting.get()}`), "Done"];

    const choice = await ctx.ui.select(
      "Supipowers Settings",
      options,
      {
        helpText: `Editing ${selectionSummary(selection)}. Changes write to ${configPathForSelection(selection)}. Esc to close.`,
      },
    );

    if (choice === undefined || choice === null || choice === "Done") {
      break;
    }

    if (choice === scopeChoice) {
      const nextSelection = await selectConfigScope(ctx, selection, workspaceTargets);
      if (nextSelection) {
        selection = nextSelection;
      }
      continue;
    }

    const index = options.indexOf(choice) - 1;
    const setting = settings[index];
    if (!setting) {
      break;
    }

    try {
      if (setting.type === "select" && setting.options) {
        const currentValue = setting.get();
        const currentIndex = setting.options.findIndex((option) => currentValue.startsWith(option.split(" — ")[0]));
        const value = await ctx.ui.select(
          setting.label,
          setting.options,
          {
            initialIndex: Math.max(0, currentIndex),
            helpText: setting.helpText,
          },
        );

        if (value !== undefined && value !== null) {
          const display = await setting.set(getSelectionCwd(selection), value);
          if (display) {
            ctx.ui.notify(`${setting.label} → ${display}`, "info");
          }
        }
      } else if (setting.type === "toggle") {
        const current = setting.get();
        const newValue = current.startsWith("on") ? "off" : "on";
        const display = await setting.set(getSelectionCwd(selection), newValue);
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

  ctx.ui.notify(
    "\nContext Mode: ✓ built-in (native tools)",
    "info",
  );
}

export function registerConfigCommand(platform: Platform): void {
  platform.registerCommand("supi:config", {
    description: "View and manage Supipowers configuration",
    async handler(_args: string | undefined, ctx: any) {
      handleConfig(platform, ctx);
    },
  });
}
