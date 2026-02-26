import type { ExtensionAPI, ToolCallEvent } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "../config";
import { shouldBlockOnMissingGate } from "../engine/policies";
import { loadState } from "../storage/state-store";

const PRE_EXECUTION_PHASES = new Set(["idle", "brainstorming", "design_pending_approval", "design_approved", "planning"]);

function isWriteTool(event: ToolCallEvent): boolean {
  return event.toolName === "edit" || event.toolName === "write";
}

export function registerToolGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (!isWriteTool(event)) return;

    const config = loadConfig(ctx.cwd);
    const state = loadState(ctx.cwd);

    if (PRE_EXECUTION_PHASES.has(state.phase)) {
      const blocking = shouldBlockOnMissingGate(config.strictness, "major");
      const reason =
        `Supipowers guard: '${event.toolName}' is blocked in phase '${state.phase}'. ` +
        "Move workflow to plan_ready/executing first (e.g., /sp-plan then /sp-execute).";

      if (blocking) {
        return { block: true, reason };
      }

      if (ctx.hasUI) {
        ctx.ui.notify(reason, "warning");
      }
    }
  });
}
