import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { appendWorkflowEvent } from "../storage/events-log";
import { autoAdvanceToPlanReady } from "./auto-plan";
import { runPlanExecution } from "./run-execution";
import { getRuntime, persistAndRender } from "./shared";

export function registerSpExecuteCommand(pi: ExtensionAPI): void {
  pi.registerCommand("sp-execute", {
    description: "Auto-prepare plan if needed, then execute with routed backend",
    async handler(args, ctx) {
      const { config, state } = getRuntime(ctx);
      const objectiveFromArgs = args.trim() || undefined;

      const prepared = autoAdvanceToPlanReady(ctx.cwd, state, config.strictness, objectiveFromArgs);
      if (!prepared.ok) {
        persistAndRender(ctx, config, prepared.state, prepared.message, "warning");
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

      if (prepared.state.phase !== state.phase || prepared.state.planArtifactPath !== state.planArtifactPath) {
        persistAndRender(ctx, config, prepared.state, prepared.message, "info");
      }

      await runPlanExecution(pi, ctx, config, prepared.state);
    },
  });
}
