import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { detectCapabilities } from "../adapters/capability-detector";
import { executeCurrentPlan } from "../execution/workflow-executor";
import { appendWorkflowEvent } from "../storage/events-log";
import { renderSupipowersUi } from "../ui/render";
import { getRuntime, persistAndRender } from "./shared";

export function registerSpExecuteCommand(pi: ExtensionAPI): void {
  pi.registerCommand("sp-execute", {
    description: "Execute current plan with routed backend (ant_colony/subagent/native)",
    async handler(_args, ctx) {
      const { config, state } = getRuntime(ctx);

      if (state.phase !== "plan_ready") {
        persistAndRender(
          ctx,
          config,
          state,
          `Cannot execute from phase '${state.phase}'. Move workflow to plan_ready first.`,
          "warning",
        );
        return;
      }

      const executingState = {
        ...state,
        phase: "executing" as const,
        blocker: undefined,
        nextAction: "Executing plan steps...",
        updatedAt: Date.now(),
      };
      persistAndRender(ctx, config, executingState, "Execution started...");

      appendWorkflowEvent(ctx.cwd, {
        ts: Date.now(),
        type: "execution_requested",
        phase: executingState.phase,
      });

      const capabilities = detectCapabilities(pi.getAllTools());
      const result = await executeCurrentPlan(
        ctx.cwd,
        state,
        config.strictness,
        capabilities,
        (update) => {
          if (!ctx.hasUI) return;
          const pct = Math.round(update.progress * 100);
          renderSupipowersUi(ctx, config, executingState, {
            fullStatusSuffix: ` | ⚙️ ${update.adapter} ${pct}%`,
            fullWidgetAppend: [
              `🤖 Execution: ${update.adapter} | ${pct}%`,
              `📶 Signal: ${update.phase} — ${update.message}`,
            ],
          });
        },
      );
      persistAndRender(ctx, config, result.state, result.message, result.ok ? "info" : "warning");
    },
  });
}
