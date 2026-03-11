import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { PlanTask, AgentResult, AgentStatus, SupipowersConfig } from "../types.js";
import { buildTaskPrompt, buildFixPrompt } from "./prompts.js";
import { isLspAvailable } from "../lsp/detector.js";
import { notifySuccess, notifyWarning, notifyError } from "../notifications/renderer.js";

export interface DispatchOptions {
  pi: ExtensionAPI;
  ctx: { cwd: string; ui: { notify(msg: string, type?: "info" | "warning" | "error"): void } };
  task: PlanTask;
  planContext: string;
  config: SupipowersConfig;
  lspAvailable: boolean;
}

export async function dispatchAgent(options: DispatchOptions): Promise<AgentResult> {
  const { pi, ctx, task, planContext, config, lspAvailable } = options;
  const startTime = Date.now();

  const prompt = buildTaskPrompt(task, planContext, config, lspAvailable);

  try {
    const result = await executeSubAgent(pi, prompt, task, config);

    const agentResult: AgentResult = {
      taskId: task.id,
      status: result.status,
      output: result.output,
      concerns: result.concerns,
      filesChanged: result.filesChanged,
      duration: Date.now() - startTime,
    };

    switch (agentResult.status) {
      case "done":
        notifySuccess(ctx, `Task ${task.id} completed`, task.name);
        break;
      case "done_with_concerns":
        notifyWarning(ctx, `Task ${task.id} done with concerns`, agentResult.concerns);
        break;
      case "blocked":
        notifyError(ctx, `Task ${task.id} blocked`, agentResult.output);
        break;
    }

    return agentResult;
  } catch (error) {
    const agentResult: AgentResult = {
      taskId: task.id,
      status: "blocked",
      output: `Agent error: ${error instanceof Error ? error.message : String(error)}`,
      filesChanged: [],
      duration: Date.now() - startTime,
    };
    notifyError(ctx, `Task ${task.id} failed`, agentResult.output);
    return agentResult;
  }
}

interface SubAgentResult {
  status: AgentStatus;
  output: string;
  concerns?: string;
  filesChanged: string[];
}

async function executeSubAgent(
  pi: ExtensionAPI,
  prompt: string,
  task: PlanTask,
  config: SupipowersConfig
): Promise<SubAgentResult> {
  throw new Error(
    "Sub-agent dispatch requires OMP runtime. " +
    "This will be connected to createAgentSession during integration."
  );
}

export async function dispatchFixAgent(
  options: DispatchOptions & { previousOutput: string; failureReason: string }
): Promise<AgentResult> {
  const { pi, ctx, task, config, lspAvailable, previousOutput, failureReason } = options;
  const startTime = Date.now();

  const prompt = buildFixPrompt(task, previousOutput, failureReason, lspAvailable);

  try {
    const result = await executeSubAgent(pi, prompt, task, config);
    return {
      taskId: task.id,
      status: result.status,
      output: result.output,
      concerns: result.concerns,
      filesChanged: result.filesChanged,
      duration: Date.now() - startTime,
    };
  } catch (error) {
    return {
      taskId: task.id,
      status: "blocked",
      output: `Fix agent error: ${error instanceof Error ? error.message : String(error)}`,
      filesChanged: [],
      duration: Date.now() - startTime,
    };
  }
}
