import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "./config";
import { registerSpExecuteCommand } from "./commands/sp-execute";
import { registerSpFinishCommand } from "./commands/sp-finish";
import { registerSpReleaseSetupCommand } from "./commands/sp-release-setup";
import { registerSpReleaseCommand } from "./commands/sp-release";
import { registerSpQaCommand } from "./commands/sp-qa";
import { registerSpResetCommand } from "./commands/sp-reset";
import { registerSpRewindCommand } from "./commands/sp-rewind";
import { registerSpStartCommand } from "./commands/sp-start";
import { registerSpStatusCommand } from "./commands/sp-status";
import { registerSpStopCommand } from "./commands/sp-stop";
import { registerSpViewCommand } from "./commands/sp-view";
import { recoverInterruptedExecutionState } from "./execution/recovery";
import { registerInputInterceptor } from "./runtime/input-interceptor";
import { registerToolGuard } from "./runtime/tool-guard";
import { registerViewToggleShortcut } from "./runtime/view-toggle-shortcut";
import { appendWorkflowEvent } from "./storage/events-log";
import { loadState, saveState } from "./storage/state-store";
import { registerSpOrchestrateTool } from "./tools/sp-orchestrate";
import { registerSpRevalidateTool } from "./tools/sp-revalidate";
import { formatStatus } from "./ui/status";
import { renderSupipowersUi } from "./ui/render";

export { formatStatus };

export default function registerSupipowers(pi: ExtensionAPI): void {
  registerSpStatusCommand(pi);
  registerSpStartCommand(pi);
  registerSpExecuteCommand(pi);
  registerSpStopCommand(pi);
  registerSpViewCommand(pi);
  registerSpRewindCommand(pi);
  registerSpFinishCommand(pi);
  registerSpResetCommand(pi);
  registerSpReleaseSetupCommand(pi);
  registerSpReleaseCommand(pi);
  registerSpQaCommand(pi);
  registerSpOrchestrateTool(pi);
  registerSpRevalidateTool(pi);
  registerToolGuard(pi);
  registerInputInterceptor(pi);
  registerViewToggleShortcut(pi);

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

    renderSupipowersUi(ctx, config, recovery.state);
  });
}
