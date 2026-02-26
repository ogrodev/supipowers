import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { transitionState } from "../engine/state-machine";
import { appendWorkflowEvent } from "../storage/events-log";
import { buildBrainstormingKickoffPrompt } from "./brainstorming-kickoff";
import { getRuntime, persistAndRender } from "./shared";

export function registerSpStartCommand(pi: ExtensionAPI): void {
  pi.registerCommand("sp-start", {
    description: "Initialize workflow and move to brainstorming",
    async handler(args, ctx) {
      const { config, state } = getRuntime(ctx);

      let objective = args.trim();
      if (!objective) {
        if (ctx.hasUI) {
          const provided = await ctx.ui.input(
            state.objective ? "Supipowers objective (press Enter to reuse current)" : "Supipowers objective",
            state.objective || "e.g. Implement login flow with tests",
          );
          objective = (provided ?? "").trim() || state.objective || "";
        } else {
          objective = state.objective || "";
        }
      }

      if (!objective) {
        if (ctx.hasUI) {
          ctx.ui.notify("Objective is required. Run /sp-start <objective>.", "warning");
        }
        return;
      }

      const result = transitionState(state, {
        to: "brainstorming",
        strictness: config.strictness,
        checkpoints: state.checkpoints,
        nextAction: "Run guided brainstorming: answer one clarifying question at a time",
      });

      const nextState = {
        ...result.state,
        objective,
      };

      if (result.ok) {
        appendWorkflowEvent(ctx.cwd, {
          ts: Date.now(),
          type: "workflow_started",
          phase: nextState.phase,
          meta: { objective: nextState.objective },
        });
      }

      persistAndRender(
        ctx,
        config,
        nextState,
        result.ok
          ? "Supipowers started: brainstorming phase active. Brainstorm kickoff dispatched."
          : `Supipowers start blocked: ${result.reason}`,
        result.ok ? "info" : "error",
      );

      if (!result.ok) return;

      const kickoffPrompt = buildBrainstormingKickoffPrompt(nextState.objective);
      pi.sendUserMessage(kickoffPrompt, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
    },
  });
}
