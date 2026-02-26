import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { stopExecution } from "../execution/workflow-executor";
import { appendWorkflowEvent } from "../storage/events-log";
import { getRuntime, persistAndRender } from "./shared";

export function registerSpStopCommand(pi: ExtensionAPI): void {
  pi.registerCommand("sp-stop", {
    description: "Stop active execution run (if any)",
    async handler(_args, ctx) {
      const { config, state } = getRuntime(ctx);
      const stop = stopExecution(ctx.cwd);

      if (!stop.stopped) {
        persistAndRender(ctx, config, state, stop.message, "warning");
        return;
      }

      const nextState = {
        ...state,
        phase: "aborted" as const,
        blocker: "Execution stop requested by user.",
        nextAction: "Run /sp-execute to retry or /sp-reset to restart workflow.",
        updatedAt: Date.now(),
      };

      appendWorkflowEvent(ctx.cwd, {
        ts: Date.now(),
        type: "execution_stopped",
        phase: nextState.phase,
        meta: { runId: stop.runId },
      });

      persistAndRender(ctx, config, nextState, stop.message, "warning");
    },
  });
}
