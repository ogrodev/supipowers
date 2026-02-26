import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { transitionState } from "../engine/state-machine";
import { appendWorkflowEvent } from "../storage/events-log";
import { getRuntime, persistAndRender } from "./shared";

export function registerSpStartCommand(pi: ExtensionAPI): void {
  pi.registerCommand("sp-start", {
    description: "Initialize workflow and move to brainstorming",
    async handler(args, ctx) {
      const { config, state } = getRuntime(ctx);
      const objective = args.trim();

      const result = transitionState(state, {
        to: "brainstorming",
        strictness: config.strictness,
        checkpoints: state.checkpoints,
        nextAction: "Draft design options and approve one with /sp-approve",
      });

      const nextState = {
        ...result.state,
        objective: objective || state.objective,
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
        result.ok ? "Supipowers started: brainstorming phase active" : `Supipowers start blocked: ${result.reason}`,
        result.ok ? "info" : "error",
      );
    },
  });
}
