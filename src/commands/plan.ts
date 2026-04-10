import type { Platform } from "../platform/types.js";

import { notifyInfo, notifyError } from "../notifications/renderer.js";
import {
  generateVisualSessionId,
  createSessionDir,
  getScriptsDir,
} from "../visual/companion.js";
import { startVisualServer } from "../visual/start-server.js";
import { buildVisualInstructions } from "../visual/prompt-instructions.js";
import { buildPlanningPrompt, buildQuickPlanPrompt } from "../planning/prompt-builder.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { modelRegistry } from "../config/model-registry-instance.js";
import { resolveModelForAction, createModelBridge, applyModelOverride } from "../config/model-resolver.js";
import { loadModelConfig } from "../config/model-config.js";
import { startPlanTracking } from "../planning/approval-flow.js";
import { stopVisualServer } from "../visual/stop-server.js";

modelRegistry.register({
  id: "plan",
  category: "command",
  label: "Plan",
  harnessRoleHint: "plan",
});

/** Module-level tracking for cleanup */
let activeSessionDir: string | null = null;

export function getActiveVisualSessionDir(): string | null {
  return activeSessionDir;
}

export function setActiveVisualSessionDir(dir: string | null): void {
  activeSessionDir = dir;
}

export function registerPlanCommand(platform: Platform): void {
  platform.registerCommand("supi:plan", {
    description: "Start collaborative planning for a feature or task",
    async handler(args: string | undefined, ctx: any) {
      // Resolve and apply model override early — before any logic that might fail
      const modelCfg = loadModelConfig(platform.paths, ctx.cwd);
      const bridge = createModelBridge(platform);
      const resolved = resolveModelForAction("plan", modelRegistry, modelCfg, bridge);
      await applyModelOverride(platform, ctx, "plan", resolved);

      const skillPath = findSkillPath("planning");
      let skillContent = "";
      if (skillPath) {
        try {
          skillContent = fs.readFileSync(skillPath, "utf-8");
        } catch {
          // Skill file not found — proceed without it
        }
      }

      const isQuick = args?.startsWith("--quick") ?? false;
      const quickDesc = isQuick ? args!.replace("--quick", "").trim() : "";

      // ── Visual companion consent ──────────────────────────────────
      let visualUrl: string | null = null;
      let visualSessionDir: string | null = null;

      if (ctx.hasUI && !isQuick) {
        const modeChoice = await ctx.ui.select(
          "Planning mode",
          [
            "Terminal only",
            "Terminal + Visual companion (opens browser)",
          ],
          { helpText: "Visual companion shows mockups and diagrams in a browser · Esc to cancel" },
        );
        if (!modeChoice) return;

        if (modeChoice.startsWith("Terminal + Visual")) {
          const sessionId = generateVisualSessionId();
          visualSessionDir = createSessionDir(platform.paths, ctx.cwd, sessionId);
          const scriptsDir = getScriptsDir();

          // Install server dependencies if needed
          const nodeModules = path.join(scriptsDir, "node_modules");
          if (!fs.existsSync(nodeModules)) {
            notifyInfo(ctx, "Installing visual companion dependencies...");
            const installResult = await platform.exec("npm", ["install", "--production"], { cwd: scriptsDir });
            if (installResult.code !== 0) {
              notifyError(ctx, "Failed to install visual companion dependencies", installResult.stderr);
              visualSessionDir = null;
            }
          }

          if (visualSessionDir) {
            // Stop any previous visual companion
            if (activeSessionDir) {
              stopVisualServer(activeSessionDir);
            }

            // Start the server in a detached cross-platform process
            const serverInfo = await startVisualServer({ sessionDir: visualSessionDir });

            if (serverInfo) {
              visualUrl = serverInfo.url;
              activeSessionDir = visualSessionDir;
              notifyInfo(ctx, "Visual companion ready", visualUrl);
            } else {
              notifyError(ctx, "Visual companion failed to start");
              visualSessionDir = null;
            }
          }
        }
      }

      // ── Build prompt ──────────────────────────────────────────────
      let prompt: string;
      if (isQuick && quickDesc) {
        prompt = buildQuickPlanPrompt(quickDesc, skillContent || undefined);
      } else {
        prompt = buildPlanningPrompt({
          topic: args || undefined,
          skillContent: skillContent || undefined,
          dotDirDisplay: platform.paths.dotDirDisplay,
        });
      }

      // Append visual companion instructions if active
      if (visualUrl && visualSessionDir) {
        prompt += "\n\n" + buildVisualInstructions(visualUrl, visualSessionDir);
      }


      platform.sendMessage(
        {
          customType: "supi-plan-start",
          content: [{ type: "text", text: prompt }],
          display: "none",
        },
        { deliverAs: "steer", triggerTurn: true }
      );

      // Track planning state for the approval flow (agent_end hook)
      startPlanTracking(ctx.cwd, platform.paths, ctx.newSession?.bind(ctx), resolved);

      notifyInfo(ctx, "Planning started", args ? `Topic: ${args}` : "Describe what you want to build");
    },
  });
}

function findSkillPath(skillName: string): string | null {
  const candidates = [
    path.join(process.cwd(), "skills", skillName, "SKILL.md"),
    path.join(__dirname, "..", "..", "skills", skillName, "SKILL.md"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}
