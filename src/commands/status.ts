import type { Platform, PlatformContext } from "../platform/types.js";
import { findActiveRun, loadAllAgentResults } from "../storage/runs.js";

export function handleStatus(platform: Platform, ctx: PlatformContext): void {
  const activeRun = findActiveRun(platform.paths, ctx.cwd);
  if (!activeRun) {
    ctx.ui.notify("No active runs — use /supi:run to execute a plan", "info");
    return;
  }

  void (async () => {
    const results = loadAllAgentResults(platform.paths, ctx.cwd, activeRun.id);
    const totalTasks = activeRun.batches.reduce(
      (sum, b) => sum + b.taskIds.length,
      0
    );
    const doneCount = results.filter((r) => r.status === "done").length;
    const concernCount = results.filter((r) => r.status === "done_with_concerns").length;
    const blockedCount = results.filter((r) => r.status === "blocked").length;
    const currentBatch = activeRun.batches.find((b) => b.status !== "completed");

    const options = [
      `Run: ${activeRun.id}`,
      `Status: ${activeRun.status}`,
      `Plan: ${activeRun.planRef}`,
      `Profile: ${activeRun.profile}`,
      `Progress: ${results.length}/${totalTasks} tasks`,
      `  Done: ${doneCount}`,
      `  With concerns: ${concernCount}`,
      `  Blocked: ${blockedCount}`,
      `Batch: ${currentBatch ? `#${currentBatch.index} (${currentBatch.status})` : "all complete"}`,
      "Close",
    ];

    await ctx.ui.select("Supipowers Status", options, {
      helpText: "Esc to close",
    });
  })();
}

export function registerStatusCommand(platform: Platform): void {
  platform.registerCommand("supi:status", {
    description: "Check on running sub-agents and task progress",
    async handler(_args, ctx) {
      handleStatus(platform, ctx);
    },
  });
}
