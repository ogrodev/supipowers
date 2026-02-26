import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { finishWorkflow, parseFinishArgs } from "../execution/finish-workflow";
import { appendWorkflowEvent } from "../storage/events-log";
import { getRuntime, persistAndRender } from "./shared";

export function registerSpFinishCommand(pi: ExtensionAPI): void {
  pi.registerCommand("sp-finish", {
    description: "Finish workflow with mode: merge|pr|keep|discard (optional --review-pass)",
    async handler(args, ctx) {
      const { config, state } = getRuntime(ctx);
      const parsed = parseFinishArgs(args);

      const result = finishWorkflow({
        cwd: ctx.cwd,
        state,
        strictness: config.strictness,
        mode: parsed.mode,
        markReviewPass: parsed.markReviewPass,
      });

      appendWorkflowEvent(ctx.cwd, {
        ts: Date.now(),
        type: "workflow_finished",
        phase: result.state.phase,
        meta: {
          ok: result.ok,
          mode: parsed.mode,
          reportPath: result.reportPath,
        },
      });

      persistAndRender(ctx, config, result.state, result.message, result.ok ? "info" : "error");
    },
  });
}
