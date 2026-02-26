import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { transitionState } from "../engine/state-machine";
import { appendWorkflowEvent } from "../storage/events-log";
import { getRuntime, persistAndRender } from "./shared";

export function registerSpApproveCommand(pi: ExtensionAPI): void {
  pi.registerCommand("sp-approve", {
    description: "Approve current design and move workflow forward",
    async handler(_args, ctx) {
      const { config, state } = getRuntime(ctx);
      let working = state;

      if (working.phase === "brainstorming") {
        const toPending = transitionState(working, {
          to: "design_pending_approval",
          strictness: config.strictness,
          checkpoints: working.checkpoints,
          nextAction: "Approve this design to continue",
        });

        if (!toPending.ok) {
          persistAndRender(ctx, config, toPending.state, `Supipowers approval blocked: ${toPending.reason}`, "error");
          return;
        }

        working = toPending.state;
      }

      const approvedState = {
        ...working,
        checkpoints: {
          ...working.checkpoints,
          hasDesignApproval: true,
        },
      };

      const toApproved = transitionState(approvedState, {
        to: "design_approved",
        strictness: config.strictness,
        checkpoints: approvedState.checkpoints,
        nextAction: "Run /sp-plan to generate the implementation plan",
      });

      if (!toApproved.ok) {
        persistAndRender(ctx, config, toApproved.state, `Supipowers approval blocked: ${toApproved.reason}`, "error");
        return;
      }

      appendWorkflowEvent(ctx.cwd, {
        ts: Date.now(),
        type: "design_approved",
        phase: toApproved.state.phase,
      });

      persistAndRender(ctx, config, toApproved.state, "Design approved. Planning can begin.");
    },
  });
}
