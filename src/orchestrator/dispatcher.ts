import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { PlanTask, AgentResult, AgentStatus, SupipowersConfig } from "../types.js";
import { buildTaskPrompt, buildFixPrompt } from "./prompts.js";
import {
  buildSpecComplianceReviewPrompt,
  buildCodeQualityReviewPrompt,
} from "./agent-prompts.js";
import { isLspAvailable } from "../lsp/detector.js";
import { notifySuccess, notifyWarning, notifyError, notifyInfo } from "../notifications/renderer.js";

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

/** Review result from a spec compliance or code quality reviewer */
export interface ReviewResult {
  passed: boolean;
  issues: string;
}

/**
 * Dispatch an implementer with 2-stage review (spec compliance + code quality).
 * Follows superpowers' subagent-driven-development pattern:
 * 1. Implementer implements + self-reviews
 * 2. Spec compliance reviewer verifies implementation matches spec
 * 3. If spec issues → re-dispatch implementer with feedback
 * 4. Code quality reviewer checks implementation quality
 * 5. If quality issues → re-dispatch implementer with feedback
 */
export async function dispatchAgentWithReview(
  options: DispatchOptions & { workDir?: string },
): Promise<AgentResult> {
  const { pi, ctx, task, planContext, config, lspAvailable, workDir } = options;
  const maxReviewRetries = config.orchestration.maxFixRetries;

  // Step 1: Dispatch implementer
  let implementResult = await dispatchAgent(options);

  // If blocked or needs context, skip reviews
  if (implementResult.status === "blocked") {
    return implementResult;
  }

  // Step 2: Spec compliance review
  for (let attempt = 0; attempt <= maxReviewRetries; attempt++) {
    const specReview = await dispatchSpecReview(pi, task, implementResult, config);

    if (specReview.passed) {
      notifyInfo(ctx, `Task ${task.id} spec review passed`);
      break;
    }

    if (attempt === maxReviewRetries) {
      notifyWarning(ctx, `Task ${task.id} spec review failed after ${maxReviewRetries + 1} attempts`, specReview.issues);
      implementResult.status = "done_with_concerns";
      implementResult.concerns = `Spec compliance issues: ${specReview.issues}`;
      return implementResult;
    }

    // Re-dispatch implementer with spec review feedback
    notifyInfo(ctx, `Task ${task.id} spec issues found, re-dispatching`, specReview.issues);
    const fixResult = await dispatchFixAgent({
      ...options,
      previousOutput: implementResult.output,
      failureReason: `Spec compliance review failed:\n${specReview.issues}`,
    });
    implementResult = fixResult;

    if (fixResult.status === "blocked") {
      return fixResult;
    }
  }

  // Step 3: Code quality review
  for (let attempt = 0; attempt <= maxReviewRetries; attempt++) {
    const qualityReview = await dispatchQualityReview(pi, task, implementResult, config);

    if (qualityReview.passed) {
      notifyInfo(ctx, `Task ${task.id} quality review passed`);
      break;
    }

    if (attempt === maxReviewRetries) {
      notifyWarning(ctx, `Task ${task.id} quality review failed after ${maxReviewRetries + 1} attempts`, qualityReview.issues);
      implementResult.status = "done_with_concerns";
      implementResult.concerns = `Code quality issues: ${qualityReview.issues}`;
      return implementResult;
    }

    // Re-dispatch implementer with quality review feedback
    notifyInfo(ctx, `Task ${task.id} quality issues found, re-dispatching`, qualityReview.issues);
    const fixResult = await dispatchFixAgent({
      ...options,
      previousOutput: implementResult.output,
      failureReason: `Code quality review failed:\n${qualityReview.issues}`,
    });
    implementResult = fixResult;

    if (fixResult.status === "blocked") {
      return fixResult;
    }
  }

  return implementResult;
}

/** Dispatch a spec compliance reviewer sub-agent */
async function dispatchSpecReview(
  pi: ExtensionAPI,
  task: PlanTask,
  implementResult: AgentResult,
  config: SupipowersConfig,
): Promise<ReviewResult> {
  const prompt = buildSpecComplianceReviewPrompt({
    taskRequirements: `Task: ${task.name}\n\n${task.description}\n\nAcceptance Criteria: ${task.criteria}`,
    implementerReport: implementResult.output,
  });

  try {
    const result = await executeSubAgent(pi, prompt, task, config);
    const passed = result.status === "done" ||
      result.output.toLowerCase().includes("spec compliant");
    return {
      passed,
      issues: passed ? "" : result.output,
    };
  } catch {
    // If reviewer fails, pass through — don't block on reviewer errors
    return { passed: true, issues: "" };
  }
}

/** Dispatch a code quality reviewer sub-agent */
async function dispatchQualityReview(
  pi: ExtensionAPI,
  task: PlanTask,
  implementResult: AgentResult,
  config: SupipowersConfig,
): Promise<ReviewResult> {
  const prompt = buildCodeQualityReviewPrompt({
    taskSummary: `Task ${task.id}: ${task.name}\n\n${task.description}`,
    implementerReport: implementResult.output,
    baseSha: "HEAD~1",
    headSha: "HEAD",
  });

  try {
    const result = await executeSubAgent(pi, prompt, task, config);
    const hasCritical = result.output.toLowerCase().includes("critical");
    return {
      passed: !hasCritical,
      issues: hasCritical ? result.output : "",
    };
  } catch {
    // If reviewer fails, pass through
    return { passed: true, issues: "" };
  }
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
