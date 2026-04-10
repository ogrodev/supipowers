import type { Platform } from "../platform/types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { moduleDir, toBashPath } from "../utils/paths.js";
import { notifyInfo } from "../notifications/renderer.js";
import { loadE2eQaConfig, saveE2eQaConfig, DEFAULT_E2E_QA_CONFIG } from "../qa/config.js";
import { loadE2eMatrix } from "../qa/matrix.js";
import { createNewE2eSession } from "../qa/session.js";
import { buildE2eOrchestratorPrompt } from "../qa/prompt-builder.js";
import { findActiveSession, getSessionDir } from "../storage/qa-sessions.js";
import type { E2eQaConfig, AppType, E2eRegression } from "../qa/types.js";
import { modelRegistry } from "../config/model-registry-instance.js";
import { resolveModelForAction, createModelBridge, applyModelOverride } from "../config/model-resolver.js";
import { loadModelConfig } from "../config/model-config.js";
import { detectAppType } from "../qa/detect-app-type.js";
import { discoverRoutes } from "../qa/discover-routes.js";

modelRegistry.register({
  id: "qa",
  category: "command",
  label: "QA",
  harnessRoleHint: "slow",
});

function getScriptsDir(): string {
  return toBashPath(path.join(moduleDir(import.meta.url), "..", "qa", "scripts"));
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

async function runSetupWizard(
  ctx: any,
  detectedAppType: string | null,
  detectedDevCommand: string | null,
  detectedPort: number | null,
): Promise<E2eQaConfig | null> {
  // 1. App type
  const appTypeChoice = await ctx.ui.select(
    "App type",
    APP_TYPE_OPTIONS,
    { helpText: detectedAppType ? `Auto-detected: ${detectedAppType}` : "Select your web app framework" },
  );
  if (!appTypeChoice) return null;
  const appType = appTypeChoice.split(" ")[0] as AppType;

  // 2. Dev command
  const defaultDev = detectedDevCommand || "npm run dev";
  const devCommand = await ctx.ui.input(
    "Dev server command",
    defaultDev,
    { helpText: "Command to start your development server" },
  );
  if (devCommand === undefined) return null;

  // 3. Port
  const defaultPort = String(detectedPort || 3000);
  const portStr = await ctx.ui.input(
    "Dev server port",
    defaultPort,
    { helpText: "Port your dev server runs on" },
  );
  if (portStr === undefined) return null;
  const port = parseInt(portStr, 10) || 3000;

  // 4. Max retries
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

export function registerQaCommand(platform: Platform): void {
  platform.registerCommand("supi:qa", {
    description: "Run autonomous E2E product testing pipeline with playwright",
    async handler(args: string | undefined, ctx: any) {
      const modelCfg = loadModelConfig(platform.paths, ctx.cwd);
      const bridge = createModelBridge(platform);
      const resolved = resolveModelForAction("qa", modelRegistry, modelCfg, bridge);
      await applyModelOverride(platform, ctx, "qa", resolved);

      const scriptsDir = getScriptsDir();

      // ── Step 1: Detect app type ─────────────────────────────────────
      let detectedType: string | null = null;
      let detectedDevCommand: string | null = null;
      let detectedPort: number | null = null;

      try {
        const detected = detectAppType(ctx.cwd);
        detectedType = detected.type;
        detectedDevCommand = detected.devCommand;
        detectedPort = detected.port;
      } catch { /* proceed without detection */ }

      // ── Step 2: Load or create config ────────────────────────────────
      let config = loadE2eQaConfig(platform.paths, ctx.cwd);

      if (!config && ctx.hasUI) {
        config = await runSetupWizard(ctx, detectedType, detectedDevCommand, detectedPort);
        if (!config) return; // user cancelled
        saveE2eQaConfig(platform.paths, ctx.cwd, config);
        ctx.ui.notify(`E2E QA config saved to ${platform.paths.dotDirDisplay}/supipowers/e2e-qa.json`, "info");
      }

      if (!config) {
        // Use defaults with detected values
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

      // ── Step 3: Check for unresolved regressions ─────────────────────
      const activeSession = findActiveSession(platform.paths, ctx.cwd);
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

      // ── Step 4: Route discovery ──────────────────────────────────────
      let discoveredRoutes = "";
      try {
        const routes = discoverRoutes(ctx.cwd, config.app.type);
        if (routes.length > 0) {
          discoveredRoutes = routes.map((r) => JSON.stringify(r)).join("\n");
        }
      } catch { /* agent will discover routes manually */ }

      if (!discoveredRoutes) {
        discoveredRoutes = '{"path": "/", "file": "unknown", "type": "page", "hasForm": false}';
      }

      // ── Step 5: Load previous matrix ─────────────────────────────────
      const previousMatrix = loadE2eMatrix(platform.paths, ctx.cwd);
      const matrixJson = previousMatrix ? JSON.stringify(previousMatrix, null, 2) : null;

      // ── Step 6: Create session ───────────────────────────────────────
      const ledger = createNewE2eSession(platform.paths, ctx.cwd, config);
      const sessionDir = toBashPath(getSessionDir(platform.paths, ctx.cwd, ledger.id));

      // ── Step 7: Load skill ───────────────────────────────────────────
      let skillContent = "";
      const skillPath = findSkillPath("qa-strategy");
      if (skillPath) {
        try {
          skillContent = fs.readFileSync(skillPath, "utf-8");
        } catch { /* proceed without */ }
      }

      // ── Step 8: Build and send prompt ────────────────────────────────
      const routeCount = discoveredRoutes.split("\n").filter(Boolean).length;

      const prompt = buildE2eOrchestratorPrompt({
        cwd: toBashPath(ctx.cwd),
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

      notifyInfo(
        ctx,
        `E2E QA started: ${config.app.type}`,
        `${routeCount} routes discovered | session ${ledger.id}`,
      );
    },
  });
}
