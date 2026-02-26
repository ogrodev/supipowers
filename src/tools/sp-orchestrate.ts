import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { detectCapabilities } from "../adapters/capability-detector";
import { loadConfig } from "../config";
import { transitionState } from "../engine/state-machine";
import { executeCurrentPlan, stopExecution } from "../execution/workflow-executor";
import { loadState, saveState } from "../storage/state-store";
import type { WorkflowPhase } from "../types";

const OrchestrateParams = Type.Object({
  action: Type.Union([
    Type.Literal("transition"),
    Type.Literal("execute"),
    Type.Literal("stop"),
  ]),
  to: Type.Optional(Type.String({ description: "Target phase for transition action" })),
});

const WORKFLOW_PHASES: WorkflowPhase[] = [
  "idle",
  "brainstorming",
  "design_pending_approval",
  "design_approved",
  "planning",
  "plan_ready",
  "executing",
  "review_pending",
  "ready_to_finish",
  "completed",
  "blocked",
  "aborted",
];

function isWorkflowPhase(value: string): value is WorkflowPhase {
  return WORKFLOW_PHASES.includes(value as WorkflowPhase);
}

export function registerSpOrchestrateTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "sp_orchestrate",
    label: "Supipowers Orchestrator",
    description:
      "Orchestrate workflow transitions and execution. Actions: transition (requires to), execute, stop.",
    parameters: OrchestrateParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = loadConfig(ctx.cwd);
      const state = loadState(ctx.cwd);

      if (params.action === "transition") {
        if (!params.to || !isWorkflowPhase(params.to)) {
          return {
            content: [{ type: "text" as const, text: "Invalid or missing 'to' phase for transition action." }],
            isError: true,
            details: {},
          };
        }

        const result = transitionState(state, {
          to: params.to,
          strictness: config.strictness,
          checkpoints: state.checkpoints,
        });

        saveState(ctx.cwd, result.state);
        return {
          content: [
            {
              type: "text" as const,
              text: result.ok
                ? `Transitioned to '${result.state.phase}'.`
                : `Transition blocked: ${result.reason}`,
            },
          ],
          isError: !result.ok,
          details: {},
        };
      }

      if (params.action === "execute") {
        const capabilities = detectCapabilities(pi.getAllTools());
        const result = await executeCurrentPlan(ctx.cwd, state, config.strictness, capabilities);
        saveState(ctx.cwd, result.state);

        return {
          content: [{ type: "text" as const, text: result.message }],
          isError: !result.ok,
          details: {},
        };
      }

      const stopResult = stopExecution(ctx.cwd);
      return {
        content: [{ type: "text" as const, text: stopResult.message }],
        isError: !stopResult.stopped,
        details: {},
      };
    },
  });
}
