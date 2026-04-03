import type { Platform } from "../platform/types.js";

import { notifyInfo, notifyError } from "../notifications/renderer.js";
import {
  generateVisualSessionId,
  createSessionDir,
  getScriptsDir,
  parseServerInfo,
} from "../visual/companion.js";
import { buildVisualInstructions } from "../visual/prompt-instructions.js";
import { buildPlanningPrompt, buildQuickPlanPrompt } from "../planning/prompt-builder.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { modelRegistry } from "../config/model-registry-instance.js";
import { resolveModelForAction, createModelBridge } from "../config/model-resolver.js";
import { loadModelConfig } from "../config/model-config.js";
import { startPlanTracking } from "../planning/approval-flow.js";

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
              const stopScript = path.join(scriptsDir, "stop-server.sh");
              await platform.exec("bash", [stopScript, activeSessionDir], { cwd: scriptsDir });
            }

            // Start the server (pass session dir via env command since ExecOptions has no env)
            const startScript = path.join(scriptsDir, "start-server.sh");
            const startResult = await platform.exec("env", [
              `SUPI_VISUAL_DIR=${visualSessionDir}`,
              "bash",
              startScript,
            ], { cwd: scriptsDir });

            if (startResult.code === 0) {
              const serverInfo = parseServerInfo(startResult.stdout);
              if (serverInfo) {
                visualUrl = serverInfo.url;
                activeSessionDir = visualSessionDir;
                notifyInfo(ctx, "Visual companion ready", visualUrl);
              } else {
                notifyError(ctx, "Visual companion started but no connection info received");
                visualSessionDir = null;
              }
            } else {
              const errorMsg = startResult.stderr || startResult.stdout;
              notifyError(ctx, "Failed to start visual companion", errorMsg);
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

      // Resolve model for this action
      const modelConfig = loadModelConfig(platform.paths, ctx.cwd);
      const bridge = createModelBridge(platform);
      const resolved = resolveModelForAction("plan", modelRegistry, modelConfig, bridge);
      if (resolved.source !== "main" && platform.setModel && resolved.model) {
        platform.setModel(resolved.model);
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
      startPlanTracking(ctx.cwd, platform.paths);

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
