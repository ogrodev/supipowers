import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { loadConfig } from "../config/loader.js";
import { findActiveRun } from "../storage/runs.js";
import { loadLatestReport } from "../storage/reports.js";
import { listPlans } from "../storage/plans.js";

export function registerSupiCommand(pi: ExtensionAPI): void {
  pi.registerCommand("supi", {
    description: "Supipowers overview — show available commands and project status",
    async handler(_args, ctx) {
      const config = loadConfig(ctx.cwd);
      const activeRun = findActiveRun(ctx.cwd);
      const latestReport = loadLatestReport(ctx.cwd);
      const plans = listPlans(ctx.cwd);

      const lines: string[] = [
        "# Supipowers",
        "",
        "## Commands",
        "  /supi:plan     — Start collaborative planning",
        "  /supi:run      — Execute a plan with sub-agents",
        "  /supi:review   — Run quality gates",
        "  /supi:qa       — Run QA pipeline",
        "  /supi:release  — Release automation",
        "  /supi:config   — Manage configuration",
        "  /supi:status   — Check running tasks",
        "",
        "## Project Status",
        `  Profile: ${config.defaultProfile}`,
        `  Plans: ${plans.length}`,
        `  Active run: ${activeRun ? activeRun.id : "none"}`,
        `  Last review: ${latestReport ? `${latestReport.timestamp.slice(0, 10)} (${latestReport.passed ? "passed" : "failed"})` : "none"}`,
      ];

      pi.sendMessage({
        customType: "supi-overview",
        content: [{ type: "text", text: lines.join("\n") }],
        display: "inline",
      });
    },
  });
}
