import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { detectCapabilities } from "../adapters/capability-detector";
import { executeCurrentPlan } from "../execution/workflow-executor";
import { appendWorkflowEvent } from "../storage/events-log";
import type { SupipowersConfig, WorkflowState } from "../types";
import { renderSupipowersUi } from "../ui/render";
import { persistAndRender } from "./shared";

export async function runPlanExecution(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  config: SupipowersConfig,
  state: WorkflowState,
): Promise<{ ok: boolean; state: WorkflowState; message: string }> {
  if (state.phase !== "plan_ready") {
    persistAndRender(
      ctx,
      config,
      state,
      `Cannot execute from phase '${state.phase}'. Move workflow to plan_ready first.`,
      "warning",
    );

    return {
      ok: false,
      state,
      message: `Cannot execute from phase '${state.phase}'.`,
    };
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
  return result;
}
