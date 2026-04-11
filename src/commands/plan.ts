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
import type { PlanningSystemPromptOptions } from "../planning/system-prompt.js";
import { createDebugLogger } from "../debug/logger.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { modelRegistry } from "../config/model-registry-instance.js";
import { resolveModelForAction, createModelBridge, applyModelOverride } from "../config/model-resolver.js";
import { loadModelConfig } from "../config/model-config.js";
import { cancelPlanTracking, startPlanTracking } from "../planning/approval-flow.js";
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
      const debugLogger = createDebugLogger(platform.paths, ctx, "plan");
      let trackingStarted = false;
      debugLogger.log("plan_command_invoked", {
        args: args ?? null,
        cwd: ctx.cwd ?? null,
        hasUI: ctx.hasUI ?? false,
      });

      try {
        // Resolve and apply model override early — before any logic that might fail
        const modelCfg = loadModelConfig(platform.paths, ctx.cwd);
        const bridge = createModelBridge(platform);
        const resolved = resolveModelForAction("plan", modelRegistry, modelCfg, bridge);
        await applyModelOverride(platform, ctx, "plan", resolved);
        debugLogger.log("plan_model_override_applied", {
          configuredAction: "plan",
        });

        const skillPath = findSkillPath("planning");
        let skillContent = "";
        if (skillPath) {
          try {
            skillContent = fs.readFileSync(skillPath, "utf-8");
          } catch {
            // Skill file not found — proceed without it
          }
        }
        debugLogger.log("planning_skill_loaded", {
          found: Boolean(skillPath),
          skillPath: skillPath ?? null,
          skillBytes: skillContent.length,
        });

        const isQuick = args?.startsWith("--quick") ?? false;
        const quickDesc = isQuick ? args!.replace("--quick", "").trim() : "";
        const quickMode = isQuick && quickDesc.length > 0;
        const planningTopic = quickMode ? quickDesc : args || undefined;

        // ── Visual companion consent ──────────────────────────────────
        let visualUrl: string | null = null;
        let visualSessionDir: string | null = null;

        if (ctx.hasUI && !quickMode) {
          const modeChoice = await ctx.ui.select(
            "Planning mode",
            [
              "Terminal only",
              "Terminal + Visual companion (opens browser)",
            ],
            { helpText: "Visual companion shows mockups and diagrams in a browser · Esc to cancel" },
          );
          if (!modeChoice) {
            debugLogger.log("visual_companion_selection_cancelled");
            return;
          }

          debugLogger.log("visual_companion_mode_selected", {
            choice: modeChoice,
          });

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
                debugLogger.log("visual_companion_dependency_install_failed", {
                  code: installResult.code,
                  stderr: installResult.stderr,
                });
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
                debugLogger.log("visual_companion_ready", {
                  url: visualUrl,
                  sessionDir: visualSessionDir,
                });
              } else {
                notifyError(ctx, "Visual companion failed to start");
                debugLogger.log("visual_companion_start_failed", {
                  sessionDir: visualSessionDir,
                });
                visualSessionDir = null;
              }
            }
          }
        } else {
          debugLogger.log("visual_companion_skipped", {
            reason: !ctx.hasUI ? "no_ui" : "quick_mode",
          });
        }

        // ── Build prompt ──────────────────────────────────────────────
        const planningPromptOptions: PlanningSystemPromptOptions = {
          topic: planningTopic,
          skillContent: skillContent || undefined,
          dotDirDisplay: platform.paths.dotDirDisplay,
          isQuick: quickMode,
        };

        let prompt = quickMode
          ? buildQuickPlanPrompt(quickDesc)
          : buildPlanningPrompt({ topic: planningTopic });

        // Append visual companion instructions if active
        if (visualUrl && visualSessionDir) {
          prompt += "\n\n" + buildVisualInstructions(visualUrl, visualSessionDir);
        }

        debugLogger.log("planning_kickoff_prompt_built", {
          quickMode,
          topic: planningTopic ?? null,
          promptLength: prompt.length,
          prompt,
        });

        // Track planning state before sending the steer message so the triggered
        // planning turn sees planning mode as active during before_agent_start.
        startPlanTracking(
          ctx.cwd,
          platform.paths,
          ctx.newSession?.bind(ctx),
          resolved,
          planningPromptOptions,
          debugLogger,
        );
        trackingStarted = true;

        platform.sendMessage(
          {
            customType: "supi-plan-start",
            content: [{ type: "text", text: prompt }],
            display: "none",
          },
          { deliverAs: "steer", triggerTurn: true }
        );
        debugLogger.log("planning_kickoff_steer_sent", {
          customType: "supi-plan-start",
          deliverAs: "steer",
          triggerTurn: true,
        });

        notifyInfo(ctx, "Planning started", planningTopic ? `Topic: ${planningTopic}` : "Describe what you want to build");
      } catch (error) {
        debugLogger.log("plan_command_failed", {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack ?? null : null,
        });
        if (trackingStarted) {
          debugLogger.log("planning_tracking_cancelled", {
            reason: "plan_command_failed_before_turn",
          });
          cancelPlanTracking();
        }
        throw error;
      }
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
