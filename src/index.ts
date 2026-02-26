import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "./config";
import { registerSpApproveCommand } from "./commands/sp-approve";
import { registerSpExecuteCommand } from "./commands/sp-execute";
import { registerSpFinishCommand } from "./commands/sp-finish";
import { registerSpPlanCommand } from "./commands/sp-plan";
import { registerSpResetCommand } from "./commands/sp-reset";
import { registerSpStartCommand } from "./commands/sp-start";
import { registerSpStatusCommand } from "./commands/sp-status";
import { registerSpStopCommand } from "./commands/sp-stop";
import { recoverInterruptedExecutionState } from "./execution/recovery";
import { registerInputInterceptor } from "./runtime/input-interceptor";
import { registerToolGuard } from "./runtime/tool-guard";
import { appendWorkflowEvent } from "./storage/events-log";
import { loadState, saveState } from "./storage/state-store";
import { registerSpOrchestrateTool } from "./tools/sp-orchestrate";
import { registerSpRevalidateTool } from "./tools/sp-revalidate";
import { buildStatusLine, formatStatus } from "./ui/status";
import { buildWidgetLines } from "./ui/widget";

export { formatStatus };

export default function registerSupipowers(pi: ExtensionAPI): void {
  registerSpStatusCommand(pi);
  registerSpStartCommand(pi);
  registerSpApproveCommand(pi);
  registerSpPlanCommand(pi);
  registerSpExecuteCommand(pi);
  registerSpStopCommand(pi);
  registerSpFinishCommand(pi);
  registerSpResetCommand(pi);
  registerSpOrchestrateTool(pi);
  registerSpRevalidateTool(pi);
  registerToolGuard(pi);
  registerInputInterceptor(pi);

  pi.on("session_start", async (_event, ctx) => {
    const config = loadConfig(ctx.cwd);
    const state = loadState(ctx.cwd);
    const recovery = recoverInterruptedExecutionState(ctx.cwd, state);

    if (recovery.recovered) {
      appendWorkflowEvent(ctx.cwd, {
        ts: Date.now(),
        type: "recovery_applied",
        phase: recovery.state.phase,
        meta: { reason: recovery.reason },
      });
    }

    saveState(ctx.cwd, recovery.state);

    if (!ctx.hasUI) return;
    if (config.showStatus) ctx.ui.setStatus("supipowers", buildStatusLine(recovery.state, config.strictness));
    if (config.showWidget) ctx.ui.setWidget("supipowers", buildWidgetLines(recovery.state, config.strictness));
  });
}
