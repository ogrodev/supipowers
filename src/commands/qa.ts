import type { Platform } from "../platform/types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadModelConfig } from "../config/model-config.js";
import { modelRegistry } from "../config/model-registry-instance.js";
import { applyModelOverride, createModelBridge, resolveModelForAction } from "../config/model-resolver.js";
import { notifyError, notifyInfo } from "../notifications/renderer.js";
import { DEFAULT_E2E_QA_CONFIG, loadE2eQaConfig, saveE2eQaConfig } from "../qa/config.js";
import { detectAppType } from "../qa/detect-app-type.js";
import { discoverRoutes, type DiscoveredRoute } from "../qa/discover-routes.js";
import { loadE2eMatrix } from "../qa/matrix.js";
import { buildE2eOrchestratorPrompt } from "../qa/prompt-builder.js";
import { createNewE2eSession } from "../qa/session.js";
import type { AppType, E2eQaConfig, E2eRegression } from "../qa/types.js";
import type { WorkspaceTarget } from "../types.js";
import { findActiveSession, getSessionDir } from "../storage/qa-sessions.js";
import { moduleDir } from "../utils/paths.js";
import { resolvePackageManager } from "../workspace/package-manager.js";
import { resolveRepoRoot } from "../workspace/repo-root.js";
import {
  buildWorkspaceTargetOptionLabel,
  parseTargetArg,
  selectWorkspaceTarget,
  type WorkspaceTargetOption,
} from "../workspace/selector.js";
import { discoverWorkspaceTargets } from "../workspace/targets.js";

modelRegistry.register({
  id: "qa",
  category: "command",
  label: "QA",
  harnessRoleHint: "slow",
});

export interface QaCommandDependencies {
  loadModelConfig: typeof loadModelConfig;
  createModelBridge: typeof createModelBridge;
  resolveModelForAction: typeof resolveModelForAction;
  applyModelOverride: typeof applyModelOverride;
  resolvePackageManager: typeof resolvePackageManager;
  discoverWorkspaceTargets: typeof discoverWorkspaceTargets;
  selectWorkspaceTarget: typeof selectWorkspaceTarget;
  loadE2eQaConfig: typeof loadE2eQaConfig;
  saveE2eQaConfig: typeof saveE2eQaConfig;
  loadE2eMatrix: typeof loadE2eMatrix;
  createNewE2eSession: typeof createNewE2eSession;
  findActiveSession: typeof findActiveSession;
  getSessionDir: typeof getSessionDir;
  detectAppType: typeof detectAppType;
  discoverRoutes: typeof discoverRoutes;
  notifyError: typeof notifyError;
  notifyInfo: typeof notifyInfo;
}

const QA_COMMAND_DEPENDENCIES: QaCommandDependencies = {
  loadModelConfig,
  createModelBridge,
  resolveModelForAction,
  applyModelOverride,
  resolvePackageManager,
  discoverWorkspaceTargets,
  selectWorkspaceTarget,
  loadE2eQaConfig,
  saveE2eQaConfig,
  loadE2eMatrix,
  createNewE2eSession,
  findActiveSession,
  getSessionDir,
  detectAppType,
  discoverRoutes,
  notifyError,
  notifyInfo,
};

function getScriptsDir(): string {
  return path.join(moduleDir(import.meta.url), "..", "qa", "scripts");
}

function findSkillPath(skillName: string): string | null {
  const candidates = [
    path.join(process.cwd(), "skills", skillName, "SKILL.md"),
    path.join(moduleDir(import.meta.url), "..", "..", "skills", skillName, "SKILL.md"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const APP_TYPE_OPTIONS = [
  "nextjs-app — Next.js App Router",
  "nextjs-pages — Next.js Pages Router",
  "react-router — React with React Router",
  "vite — Vite-based app",
  "express — Express.js server",
  "generic — Other web app",
];

const RETRY_OPTIONS = [
  "1",
  "2 (recommended)",
  "3",
];

function buildQaTargetOptionLabel(option: WorkspaceTargetOption<WorkspaceTarget>): string {
  return buildWorkspaceTargetOptionLabel(option, [option.target.kind === "root" ? "repo root" : "workspace package"]);
}

function describeTarget(target: WorkspaceTarget): string {
  return target.kind === "root" ? target.name : `${target.name} (${target.relativeDir})`;
}

interface QaTargetInspection {
  detectedType: AppType | null;
  detectedDevCommand: string | null;
  detectedPort: number | null;
  detectedIsLikelyApp: boolean;
  preliminaryRoutes: DiscoveredRoute[];
  isRunnable: boolean;
  isRunnableForPrefilter: boolean;
}

function inspectQaTarget(target: WorkspaceTarget, deps: QaCommandDependencies): QaTargetInspection {
  let detectedType: AppType | null = null;
  let detectedDevCommand: string | null = null;
  let detectedPort: number | null = null;
  let detectedIsLikelyApp = false;
  let preliminaryRoutes: DiscoveredRoute[] = [];
  let detectionFailed = false;

  try {
    const detected = deps.detectAppType(target.packageDir);
    detectedType = detected.type;
    detectedDevCommand = detected.devCommand;
    detectedPort = detected.port;
    detectedIsLikelyApp = detected.isLikelyApp;
  } catch {
    detectionFailed = true;
  }

  if (!detectionFailed && detectedType) {
    try {
      preliminaryRoutes = deps.discoverRoutes(target.packageDir, detectedType);
    } catch {
      detectionFailed = true;
    }
  }

  const isRunnable = detectedIsLikelyApp || preliminaryRoutes.length > 0;

  return {
    detectedType,
    detectedDevCommand,
    detectedPort,
    detectedIsLikelyApp,
    preliminaryRoutes,
    isRunnable,
    isRunnableForPrefilter: !detectionFailed && isRunnable,
  };
}

async function runSetupWizard(
  ctx: any,
  detectedAppType: string | null,
  detectedDevCommand: string | null,
  detectedPort: number | null,
): Promise<E2eQaConfig | null> {
  const appTypeChoice = await ctx.ui.select(
    "App type",
    APP_TYPE_OPTIONS,
    { helpText: detectedAppType ? `Auto-detected: ${detectedAppType}` : "Select your web app framework" },
  );
  if (!appTypeChoice) return null;
  const appType = appTypeChoice.split(" ")[0] as AppType;

  const defaultDev = detectedDevCommand || "npm run dev";
  const devCommand = await ctx.ui.input(
    "Dev server command",
    defaultDev,
    { helpText: "Command to start your development server" },
  );
  if (devCommand === undefined) return null;

  const defaultPort = String(detectedPort || 3000);
  const portStr = await ctx.ui.input(
    "Dev server port",
    defaultPort,
    { helpText: "Port your dev server runs on" },
  );
  if (portStr === undefined) return null;
  const port = parseInt(portStr, 10) || 3000;

  const retryChoice = await ctx.ui.select(
    "Max test retries",
    RETRY_OPTIONS,
    { helpText: "How many times to retry failing tests" },
  );
  if (!retryChoice) return null;
  const maxRetries = parseInt(retryChoice, 10);

  return {
    app: {
      type: appType,
      devCommand: devCommand || defaultDev,
      port,
      baseUrl: `http://localhost:${port}`,
    },
    playwright: {
      headless: true,
      timeout: 30000,
    },
    execution: {
      maxRetries,
      maxFlows: 20,
    },
  };
}

export async function handleQa(
  platform: Platform,
  ctx: any,
  args: string | undefined,
  deps: QaCommandDependencies = QA_COMMAND_DEPENDENCIES,
): Promise<void> {
  const modelCfg = deps.loadModelConfig(platform.paths, ctx.cwd);
  const bridge = deps.createModelBridge(platform);
  const resolved = deps.resolveModelForAction("qa", modelRegistry, modelCfg, bridge);
  await deps.applyModelOverride(platform, ctx, "qa", resolved);

  const repoRoot = await resolveRepoRoot(platform, ctx.cwd);
  const packageManager = deps.resolvePackageManager(repoRoot);
  const targets = deps.discoverWorkspaceTargets(repoRoot, packageManager.id);
  if (targets.length === 0) {
    deps.notifyError(ctx, "QA target not found", "Create a package.json with name and version before running /supi:qa.");
    return;
  }

  const requestedTarget = parseTargetArg(args);
  const targetInspections = new Map<string, QaTargetInspection>();
  const getTargetInspection = (target: WorkspaceTarget): QaTargetInspection => {
    const existing = targetInspections.get(target.id);
    if (existing) return existing;

    const inspection = inspectQaTarget(target, deps);
    targetInspections.set(target.id, inspection);
    return inspection;
  };

  let selectedTarget: WorkspaceTarget | null = null;
  let selectedInspection: QaTargetInspection | null = null;

  if (!ctx.hasUI && !requestedTarget && targets.length > 1) {
    const runnableTargets = targets
      .map((target) => ({ target, inspection: getTargetInspection(target) }))
      .filter(({ inspection }) => inspection.isRunnableForPrefilter);

    if (runnableTargets.length === 1) {
      selectedTarget = runnableTargets[0]!.target;
      selectedInspection = runnableTargets[0]!.inspection;
    } else {
      deps.notifyError(ctx, "QA target required", "Pass --target <package> when running /supi:qa outside interactive mode.");
      return;
    }
  }

  if (!selectedTarget) {
    selectedTarget = await deps.selectWorkspaceTarget(
      ctx,
      targets.map((target) => ({ target, changed: false, label: buildQaTargetOptionLabel({ target, changed: false }) })),
      requestedTarget,
      {
        title: "QA target",
        helpText: "Pick one app package to test. QA runs only within the selected target.",
      },
    );
  }
  if (requestedTarget && !selectedTarget) {
    deps.notifyError(ctx, "QA target not found", requestedTarget);
    return;
  }
  if (!selectedTarget) {
    return;
  }

  selectedInspection ??= getTargetInspection(selectedTarget);

  const scriptsDir = getScriptsDir();
  const targetDir = selectedTarget.packageDir;
  const targetLabel = describeTarget(selectedTarget);

  const {
    detectedType,
    detectedDevCommand,
    detectedPort,
    detectedIsLikelyApp,
    preliminaryRoutes,
  } = selectedInspection;

  if (!detectedIsLikelyApp && preliminaryRoutes.length === 0) {
    deps.notifyError(
      ctx,
      "Selected target is not a runnable app",
      `${targetLabel} has no detectable app framework, routes, or dev/start script. Pick an app package instead.`,
    );
    return;
  }

  let config = deps.loadE2eQaConfig(platform.paths, ctx.cwd, selectedTarget);

  if (!config && ctx.hasUI) {
    config = await runSetupWizard(ctx, detectedType, detectedDevCommand, detectedPort);
    if (!config) return;
    deps.saveE2eQaConfig(platform.paths, ctx.cwd, config, selectedTarget);
    ctx.ui.notify(`E2E QA config saved for ${targetLabel}`, "info");
  }

  if (!config) {
    config = {
      ...DEFAULT_E2E_QA_CONFIG,
      app: {
        type: (detectedType as AppType) || "generic",
        devCommand: detectedDevCommand || "npm run dev",
        port: detectedPort || 3000,
        baseUrl: `http://localhost:${detectedPort || 3000}`,
      },
    };
  }

  const activeSession = deps.findActiveSession(platform.paths, ctx.cwd, selectedTarget);
  if (activeSession && activeSession.regressions.length > 0 && ctx.hasUI) {
    const unresolvedRegressions = activeSession.regressions.filter((r: E2eRegression) => !r.resolution);
    if (unresolvedRegressions.length > 0) {
      for (const regression of unresolvedRegressions) {
        const choice = await ctx.ui.select(
          `Regression: ${regression.flowName}`,
          [
            "This is a bug — needs fixing",
            "Behavior changed intentionally — update the test",
            "Skip for now",
          ],
          { helpText: `Was passing, now fails: ${regression.error}` },
        );
        if (!choice) continue;
        if (choice.startsWith("This is a bug")) regression.resolution = "bug";
        else if (choice.startsWith("Behavior changed")) regression.resolution = "intentional-change";
        else regression.resolution = "skipped";
      }
    }
  }

  let routes = preliminaryRoutes;
  try {
    if (config.app.type !== detectedType) {
      routes = deps.discoverRoutes(targetDir, config.app.type);
    }
  } catch {
    routes = [];
  }

  let discoveredRoutes = "";
  if (routes.length > 0) {
    discoveredRoutes = routes.map((r) => JSON.stringify(r)).join("\n");
  }
  if (!discoveredRoutes) {
    discoveredRoutes = '{"path": "/", "file": "unknown", "type": "page", "hasForm": false}';
  }

  const previousMatrix = deps.loadE2eMatrix(platform.paths, ctx.cwd, selectedTarget);
  const matrixJson = previousMatrix ? JSON.stringify(previousMatrix, null, 2) : null;

  const ledger = deps.createNewE2eSession(platform.paths, ctx.cwd, config, selectedTarget);
  const sessionDir = deps.getSessionDir(platform.paths, ctx.cwd, ledger.id, selectedTarget);

  let skillContent = "";
  const skillPath = findSkillPath("qa-strategy");
  if (skillPath) {
    try {
      skillContent = fs.readFileSync(skillPath, "utf-8");
    } catch {
      // proceed without skill content
    }
  }

  const routeCount = discoveredRoutes.split("\n").filter(Boolean).length;

  const prompt = buildE2eOrchestratorPrompt({
    cwd: targetDir,
    appType: config.app,
    sessionDir,
    scriptsDir,
    config,
    discoveredRoutes,
    previousMatrix: matrixJson,
    skillContent,
    dotDirDisplay: platform.paths.dotDirDisplay,
  });

  platform.sendMessage(
    {
      customType: "supi-qa",
      content: [{ type: "text", text: prompt }],
      display: "none",
    },
    { deliverAs: "steer", triggerTurn: true },
  );

  deps.notifyInfo(
    ctx,
    `E2E QA started: ${config.app.type}`,
    `${routeCount} routes discovered | session ${ledger.id} | ${targetLabel}`,
  );
}

export function registerQaCommand(platform: Platform): void {
  platform.registerCommand("supi:qa", {
    description: "Run autonomous E2E product testing pipeline with playwright",
    async handler(args: string | undefined, ctx: any) {
      await handleQa(platform, ctx, args, QA_COMMAND_DEPENDENCIES);
    },
  });
}
