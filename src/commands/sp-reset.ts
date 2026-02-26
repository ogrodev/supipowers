import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { appendWorkflowEvent } from "../storage/events-log";
import { defaultState } from "../storage/state-store";
import { getRuntime, persistAndRender } from "./shared";

export function registerSpResetCommand(pi: ExtensionAPI): void {
  pi.registerCommand("sp-reset", {
    description: "Reset workflow state to idle (use --yes to skip confirmation)",
    async handler(args, ctx) {
      const { config } = getRuntime(ctx);
      const confirmedByFlag = args.includes("--yes");

      if (!confirmedByFlag && ctx.hasUI) {
        const ok = await ctx.ui.confirm(
          "Reset Supipowers workflow",
          "This will reset workflow state to idle. Continue?",
        );
        if (!ok) {
          if (ctx.hasUI) ctx.ui.notify("Reset cancelled.", "info");
          return;
        }
      }

      const nextState = defaultState();

      appendWorkflowEvent(ctx.cwd, {
        ts: Date.now(),
        type: "workflow_reset",
        phase: nextState.phase,
      });

      persistAndRender(ctx, config, nextState, "Supipowers workflow reset to idle.", "info");
    },
  });
}
