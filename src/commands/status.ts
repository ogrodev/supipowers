import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { findActiveRun, loadAllAgentResults } from "../storage/runs.js";
import { notifyInfo } from "../notifications/renderer.js";

export function registerStatusCommand(pi: ExtensionAPI): void {
  pi.registerCommand("supi:status", {
    description: "Check on running sub-agents and task progress",
    async handler(_args, ctx) {
      const activeRun = findActiveRun(ctx.cwd);

      if (!activeRun) {
        notifyInfo(ctx, "No active runs", "Use /supi:run to execute a plan");
        return;
      }

      const results = loadAllAgentResults(ctx.cwd, activeRun.id);
      const completedIds = new Set(results.map((r) => r.taskId));
      const totalTasks = activeRun.batches.reduce(
        (sum, b) => sum + b.taskIds.length,
        0
      );
      const completedCount = results.length;
      const doneCount = results.filter((r) => r.status === "done").length;
      const concernCount = results.filter((r) => r.status === "done_with_concerns").length;
      const blockedCount = results.filter((r) => r.status === "blocked").length;

      const currentBatch = activeRun.batches.find((b) => b.status !== "completed");

      const lines = [
        `# Run: ${activeRun.id}`,
        "",
        `Status: ${activeRun.status}`,
        `Plan: ${activeRun.planRef}`,
        `Profile: ${activeRun.profile}`,
        `Progress: ${completedCount}/${totalTasks} tasks`,
        "",
        `  Done: ${doneCount}`,
        `  With concerns: ${concernCount}`,
        `  Blocked: ${blockedCount}`,
        "",
        `Current batch: ${currentBatch ? `#${currentBatch.index} (${currentBatch.status})` : "none"}`,
      ];

      pi.sendMessage({
        customType: "supi-status",
        content: [{ type: "text", text: lines.join("\n") }],
        display: "inline",
      });
    },
  });
}
