import type { Platform } from "./platform/types.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerSupiCommand, handleSupi } from "./commands/supi.js";
import { registerConfigCommand, handleConfig } from "./commands/config.js";
import { registerStatusCommand, handleStatus } from "./commands/status.js";
import { registerPlanCommand, getActiveVisualSessionDir, setActiveVisualSessionDir } from "./commands/plan.js";
import { stopVisualServer } from "./visual/stop-server.js";
import { registerChecksCommand, handleChecksCommand } from "./commands/review.js";
import { registerAiReviewCommand, handleAiReview } from "./commands/ai-review.js";
import { registerQaCommand } from "./commands/qa.js";
import { registerReleaseCommand, handleRelease } from "./commands/release.js";
import { registerUpdateCommand, handleUpdate } from "./commands/update.js";
import { execCli } from "./utils/exec-cli.js";
import { registerDoctorCommand, handleDoctor } from "./commands/doctor.js";
import { registerModelCommand, handleModel } from "./commands/model.js";
import { registerFixPrCommand } from "./commands/fix-pr.js";
import { registerContextCommand, handleContext } from "./commands/context.js";
import { registerOptimizeContextCommand, handleOptimizeContext } from "./commands/optimize-context.js";
import { registerClearCommand, handleClear } from "./commands/clear.js";
import { registerCommitCommand, handleCommit } from "./commands/commit.js";
import { registerGenerateCommand } from "./commands/generate.js";
import { registerAgentsCommand, handleAgents } from "./commands/agents.js";
import { registerMemoryCommand, handleMemory } from "./commands/memory.js";
import { registerUltraplanCommand, handleUltraplan } from "./commands/ultraplan.js";
import { registerHarnessCommand, handleHarness } from "./harness/command.js";
import { registerHarnessPipelineTools } from "./harness/tools.js";
import { registerHarnessHooks } from "./harness/hooks/register.js";
import { loadConfig } from "./config/loader.js";
import { registerContextModeHooks } from "./context-mode/hooks.js";
import { registerPlanApprovalHook } from "./planning/approval-flow.js";
import { registerPlanningSystemPromptHook } from "./planning/system-prompt.js";
import { registerPlanningAskTool, registerPlanningAskToolGuard } from "./planning/planning-ask-tool.js";
import { registerUiDesignCommand } from "./commands/ui-design.js";
import { registerUiDesignSystemPromptHook } from "./ui-design/system-prompt.js";
import {
  registerUiDesignApprovalHook,
  registerUiDesignToolGuard,
  stopActiveUiDesignSession,
} from "./ui-design/session.js";
import { registerUltraPlanRuntimeTools } from "./ultraplan/execution/runtime-tools.js";
import { registerUltraPlanAuthoringTool } from "./ultraplan/authoring-tool.js";
import { registerUltraPlanAuthoringPipelineTools } from "./ultraplan/authoring/authoring-tools.js";
import { registerActiveToolController } from "./tool-catalog/active-tool-controller.js";
import { registerMempalaceHooks } from "./mempalace/hooks.js";
import { registerRunbookCommand, handleRunbook } from "./commands/runbook.js";
import { registerMempalaceTool } from "./mempalace/tool.js";

// TUI-only commands — intercepted at the input level to prevent
// message submission and "Working..." indicator
const TUI_COMMANDS: Record<string, (platform: Platform, ctx: any, args?: string) => void> = {
  "supi": (platform, ctx) => handleSupi(platform, ctx),
  "supi:config": (platform, ctx) => handleConfig(platform, ctx),
  "supi:status": (platform, ctx) => handleStatus(platform, ctx),
  "supi:review": (platform, ctx, args) => handleAiReview(platform, ctx, args),
  "supi:update": (platform, ctx) => handleUpdate(platform, ctx),
  "supi:doctor": (platform, ctx) => handleDoctor(platform, ctx),
  "supi:model": (platform, ctx) => handleModel(platform, ctx),
  "supi:context": (platform, ctx) => handleContext(platform, ctx),
  "supi:optimize-context": (platform, ctx, args) => handleOptimizeContext(platform, ctx, args),
  "supi:clear": (platform, ctx, args) => handleClear(platform, ctx, args),
  "supi:commit": (platform, ctx, args) => handleCommit(platform, ctx, args),
  "supi:release": (platform, ctx, args) => handleRelease(platform, ctx, args),
  "supi:checks": (platform, ctx, args) => handleChecksCommand(platform, ctx, args),
  "supi:agents": (platform, ctx, args) => handleAgents(platform, ctx, args),
  "supi:ultraplan": (platform, ctx, args) => handleUltraplan(platform, ctx, args),
  "supi:harness": (platform, ctx, args) => { void handleHarness(platform, ctx, args); },
  "supi:memory": (platform, ctx, args) => handleMemory(platform, ctx, args),
  "runbook": (platform, ctx, args) => handleRunbook(platform, ctx, args),
};

function getInstalledVersion(platform: Platform): string | null {
  const pkgPath = platform.paths.agent("extensions", "supipowers", "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    return JSON.parse(readFileSync(pkgPath, "utf8")).version;
  } catch {
    return null;
  }
}

export function bootstrap(platform: Platform): void {
  // Register all commands (needed for autocomplete)
  registerSupiCommand(platform);
  registerConfigCommand(platform);
  registerStatusCommand(platform);
  registerPlanCommand(platform);
  registerChecksCommand(platform);
  registerAiReviewCommand(platform);
  registerQaCommand(platform);
  registerReleaseCommand(platform);
  registerUpdateCommand(platform);
  registerFixPrCommand(platform);
  registerDoctorCommand(platform);
  registerModelCommand(platform);
  registerContextCommand(platform);
  registerOptimizeContextCommand(platform);
  registerClearCommand(platform);
  registerCommitCommand(platform);
  registerGenerateCommand(platform);
  registerAgentsCommand(platform);
  registerUiDesignCommand(platform);
  registerUltraplanCommand(platform);
  registerHarnessCommand(platform);
  registerMemoryCommand(platform);
  registerRunbookCommand(platform);


  registerUltraPlanRuntimeTools(platform);
  registerUltraPlanAuthoringTool(platform);
  registerUltraPlanAuthoringPipelineTools(platform);
  registerHarnessPipelineTools(platform);

  // Register plan approval flow (agent_end hook for plan approval UI)
  registerPlanApprovalHook(platform);
  registerPlanningAskTool(platform);
  registerPlanningAskToolGuard(platform);

  // Register ui-design approval flow + runtime write-scope guard
  registerUiDesignApprovalHook(platform);
  registerUiDesignToolGuard(platform);

  // Intercept TUI-only commands at the input level — this runs BEFORE
  // message submission, so no chat message appears and no "Working..." indicator
  platform.on("input", (event, ctx) => {
    const text = event.text.trim();
    if (!text.startsWith("/")) return;

    const spaceIndex = text.indexOf(" ");
    const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);

    const handler = TUI_COMMANDS[commandName];
    if (!handler) return;

    const args = spaceIndex === -1 ? undefined : text.slice(spaceIndex + 1);
    handler(platform, ctx, args);
    return { action: "handled" };
  });

  // Context-mode integration
  const config = loadConfig(platform.paths, process.cwd());
  registerActiveToolController(platform, config);
  registerContextModeHooks(platform, config);
  registerMempalaceTool(platform, config);
  registerMempalaceHooks(platform, config);

  // Planning-mode prompt override — registered after context-mode and MemPalace so it wins
  // when /supi:plan is active and otherwise stays dormant.
  registerPlanningSystemPromptHook(platform);
  registerUiDesignSystemPromptHook(platform);

  // Register harness anti-slop hooks only for repos with a harness marker at extension boot.
  // Registered handlers also check the marker per event, so removing the marker disables
  // an already-started process without affecting other repos.
  registerHarnessHooks(platform);


  // Session start
  platform.on("session_start", async (_event, ctx) => {
    // Clean up any leftover visual companion from a previous session
    const previousVisualDir = getActiveVisualSessionDir();
    if (previousVisualDir) {
      stopVisualServer(previousVisualDir);
      setActiveVisualSessionDir(null);
    }

    // Clean up any leftover ui-design companion from a previous session
    await stopActiveUiDesignSession();

    // Clear leftover model-override status from a previous session.
    // OMP's StatusLine never clears hook statuses on /new, so extensions must do it.
    ctx.ui?.setStatus?.("supi-model", undefined);

    // Check for updates in the background
    const currentVersion = getInstalledVersion(platform);
    if (!currentVersion) return;

    execCli((cmd, args, opts) => platform.exec(cmd, args, opts), "npm", ["view", "supipowers", "version"], { cwd: tmpdir() })
      .then((result) => {
        if (result.code !== 0) return;
        const latest = result.stdout.trim();
        if (latest && latest !== currentVersion) {
          ctx.ui.notify(
            `supipowers v${latest} available (current: v${currentVersion}). Run /supi:update`,
            "info",
          );
        }
      })
      .catch(() => {
        // Network error — silently ignore
      });
  });

  // Session shutdown
  platform.on("session_shutdown", async () => {
    await stopActiveUiDesignSession();
  });
}
