import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { transitionState } from "../engine/state-machine";
import { writePlanArtifact } from "../storage/artifacts";
import { appendWorkflowEvent } from "../storage/events-log";
import { getRuntime, persistAndRender } from "./shared";

export function registerSpPlanCommand(pi: ExtensionAPI): void {
  pi.registerCommand("sp-plan", {
    description: "Create implementation plan artifact and move to plan_ready",
    async handler(_args, ctx) {
      const { config, state } = getRuntime(ctx);

      if (state.phase === "brainstorming" || state.phase === "design_pending_approval") {
        persistAndRender(
          ctx,
          config,
          state,
          "Approve the design first with /sp-approve before creating the implementation plan.",
          "warning",
        );
        return;
      }

      let working = state;
      if (working.phase === "design_approved") {
        const toPlanning = transitionState(working, {
          to: "planning",
          strictness: config.strictness,
          checkpoints: working.checkpoints,
          nextAction: "Generate plan artifact",
        });

        if (!toPlanning.ok) {
          persistAndRender(ctx, config, toPlanning.state, `Supipowers plan blocked: ${toPlanning.reason}`, "error");
          return;
        }
        working = toPlanning.state;
      }

      if (working.phase !== "planning") {
        persistAndRender(
          ctx,
          config,
          working,
          `Cannot create plan from phase '${working.phase}'. Move workflow to planning first.`,
          "warning",
        );
        return;
      }

      const planPath = writePlanArtifact(ctx.cwd, working.objective ?? "");
      const withPlan = {
        ...working,
        planArtifactPath: planPath,
        checkpoints: {
          ...working.checkpoints,
          hasPlanArtifact: true,
        },
      };

      const toReady = transitionState(withPlan, {
        to: "plan_ready",
        strictness: config.strictness,
        checkpoints: withPlan.checkpoints,
        nextAction: "Run /sp-execute to execute the approved plan",
      });

      if (!toReady.ok) {
        persistAndRender(ctx, config, toReady.state, `Supipowers plan blocked: ${toReady.reason}`, "error");
        return;
      }

      appendWorkflowEvent(ctx.cwd, {
        ts: Date.now(),
        type: "plan_ready",
        phase: toReady.state.phase,
        meta: { planPath },
      });

      persistAndRender(ctx, config, toReady.state, `Plan artifact created at ${planPath}`);
    },
  });
}
