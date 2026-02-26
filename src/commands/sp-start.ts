import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { appendWorkflowEvent } from "../storage/events-log";
import { autoAdvanceToPlanReady } from "./auto-plan";
import { runPlanExecution } from "./run-execution";
import { getRuntime, persistAndRender } from "./shared";

export function registerSpStartCommand(pi: ExtensionAPI): void {
  pi.registerCommand("sp-start", {
    description: "Start workflow, auto-generate plan, and optionally execute immediately",
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

      const prepared = autoAdvanceToPlanReady(ctx.cwd, state, config.strictness, objective);
      if (!prepared.ok) {
        persistAndRender(ctx, config, prepared.state, prepared.message, "error");
        return;
      }

      prepared.events.forEach((event) => {
        appendWorkflowEvent(ctx.cwd, {
          ts: Date.now(),
          type: event.type,
          phase: event.phase,
          meta: event.meta,
        });
      });

      persistAndRender(ctx, config, prepared.state, `${prepared.message} Execute now?`, "info");

      const runNow = ctx.hasUI
        ? await ctx.ui.confirm(
          "Supipowers plan is ready",
          `${prepared.message}\n\nDo you want to execute it now? (You can also run /sp-execute later.)`,
        )
        : true;

      if (!runNow) return;

      await runPlanExecution(pi, ctx, config, prepared.state);
    },
  });
}
