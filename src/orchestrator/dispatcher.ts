import type { Platform } from "../platform/types.js";
import type {
  PlanTask,
  AgentResult,
  AgentStatus,
  SupipowersConfig,
} from "../types.js";
import { buildTaskPrompt, buildFixPrompt } from "./prompts.js";
import {
  buildSpecComplianceReviewPrompt,
  buildCodeQualityReviewPrompt,
} from "./agent-prompts.js";
import { isLspAvailable } from "../lsp/detector.js";
import { detectContextMode } from "../context-mode/detector.js";
import {
  notifySuccess,
  notifyWarning,
  notifyError,
  notifyInfo,
} from "../notifications/renderer.js";
import type { RunProgressState } from "./run-progress.js";
import { modelRegistry } from "../config/model-registry-instance.js";
import { resolveAllCandidates, createModelBridge, type ModelPlatformBridge } from "../config/model-resolver.js";
import { loadModelConfig } from "../config/model-config.js";

modelRegistry.register({
  id: "implementer",
  category: "sub-agent",
  parent: "run",
  label: "Implementer",
  harnessRoleHint: "default",
});

modelRegistry.register({
  id: "spec-reviewer",
  category: "sub-agent",
  parent: "run",
  label: "Spec Reviewer",
  harnessRoleHint: "slow",
});

modelRegistry.register({
  id: "quality-reviewer",
  category: "sub-agent",
  parent: "run",
  label: "Quality Reviewer",
  harnessRoleHint: "slow",
});

modelRegistry.register({
  id: "fix-agent",
  category: "sub-agent",
  parent: "run",
  label: "Fix Agent",
  harnessRoleHint: "default",
});

export interface DispatchOptions {
  platform: Platform;
  ctx: {
    cwd: string;
    ui: { notify(msg: string, type?: "info" | "warning" | "error"): void };
  };
  task: PlanTask;
  planContext: string;
  config: SupipowersConfig;
  lspAvailable: boolean;
  contextModeAvailable: boolean;
  progress?: RunProgressState;
  actionId?: string;
  signal?: AbortSignal;
  parentSessionModel?: string;
}

/** Check if an error looks like a model/auth configuration issue */
function isModelAuthError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    msg.includes("No API key") ||
    msg.includes("API key") ||
    msg.includes("authentication") ||
    msg.includes("unauthorized") ||
    msg.includes("model not found") ||
    msg.includes("model_not_found") ||
    msg.includes("invalid_api_key") ||
    msg.includes("Could not resolve model")
  );
}

/** Create a user-friendly error message from a raw error */
function friendlyErrorMessage(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  if (msg.includes("No API key") || msg.includes("invalid_api_key")) {
    return "Model configuration issue — no valid API key found. Run /supi:models to configure, or ensure your agent has a model set up.";
  }
  if (msg.includes("model not found") || msg.includes("model_not_found") || msg.includes("Could not resolve model")) {
    return "Configured model is not available. Run /supi:models to pick a different model, or remove the override to use your agent's default.";
  }
  if (msg.includes("Sub-agent dispatch is not available")) {
    return msg; // This one is already user-friendly
  }
  return `Agent error: ${msg}`;
}

export async function dispatchAgent(
  options: DispatchOptions,
): Promise<AgentResult> {
  const { platform, ctx, task, planContext, config, lspAvailable, contextModeAvailable, progress, signal } = options;
  const startTime = Date.now();

  const prompt = buildTaskPrompt(task, planContext, config, lspAvailable, contextModeAvailable);

  // Check abort before starting
  if (signal?.aborted) {
    progress?.setStatus(task.id, "blocked", "Interrupted by user");
    return {
      taskId: task.id,
      status: "blocked" as AgentStatus,
      output: "Interrupted by user",
      filesChanged: [],
      duration: 0,
    };
  }

  // Initialize widget card if available
  progress?.setStatus(task.id, "running");

  // Build the full fallback chain of model candidates
  const modelConfig = loadModelConfig(platform.paths, ctx.cwd);
  const bridge = createModelBridge(platform);
  const candidates = resolveAllCandidates(
    options.actionId ?? "implementer",
    modelRegistry,
    modelConfig,
    bridge,
  );

  // Add parentSessionModel as final fallback if not already in candidates
  if (options.parentSessionModel) {
    const alreadyPresent = candidates.some((c) => c.model === options.parentSessionModel);
    if (!alreadyPresent) {
      candidates.push({ model: options.parentSessionModel, thinkingLevel: null, source: "main" });
    }
  }

  // If no candidates at all, try with no model (let platform use its own default)
  if (candidates.length === 0) {
    candidates.push({ model: undefined, thinkingLevel: null, source: "main" });
  }

  let lastError: unknown = null;

  // Try each candidate model; only retry on model/auth errors
  for (const candidate of candidates) {
    try {
      const result = await executeSubAgent(
        platform, prompt, task, config, ctx, progress,
        candidate.model, candidate.thinkingLevel, signal,
      );

      const agentResult: AgentResult = {
        taskId: task.id,
        status: result.status,
        output: result.output,
        concerns: result.concerns,
        filesChanged: result.filesChanged,
        duration: Date.now() - startTime,
      };

      // Update widget with final status (no error notification here — callers handle it)
      switch (agentResult.status) {
        case "done":
          progress?.setStatus(task.id, "done");
          notifySuccess(ctx, `Task ${task.id} completed`, task.name);
          break;
        case "done_with_concerns":
          progress?.setStatus(task.id, "done_with_concerns", agentResult.concerns);
          notifyWarning(ctx, `Task ${task.id} done with concerns`, agentResult.concerns);
          break;
        case "blocked":
          progress?.setStatus(task.id, "blocked", agentResult.output);
          // Don't notifyError here — the run loop handles retries and cascade
          break;
      }

      return agentResult;
    } catch (error) {
      lastError = error;

      // If this is NOT a model/auth error, don't try other candidates
      if (!isModelAuthError(error)) {
        break;
      }

      // Model/auth error — try next candidate silently
      // Only log at info level so we don't alarm the user
      if (candidates.indexOf(candidate) < candidates.length - 1) {
        notifyInfo(
          ctx,
          `Task ${task.id} model fallback`,
          `Trying next model candidate...`,
        );
      }
    }
  }

  // All candidates exhausted or non-model error
  const errorMsg = friendlyErrorMessage(lastError);
  progress?.setStatus(task.id, "blocked", errorMsg);

  const agentResult: AgentResult = {
    taskId: task.id,
    status: "blocked",
    output: errorMsg,
    filesChanged: [],
    duration: Date.now() - startTime,
  };
  // Don't notifyError here — let the run loop handle it after retries
  return agentResult;
}

interface SubAgentResult {
  status: AgentStatus;
  output: string;
  concerns?: string;
  filesChanged: string[];
}

type NotifyCtx = { ui: { notify(msg: string, type?: "info" | "warning" | "error"): void } };

/** Shorten a file path for display */
function shortenPath(filePath: string): string {
  const parts = filePath.split("/");
  return parts.length > 3
    ? `.../${parts.slice(-3).join("/")}`
    : filePath;
}

/** Format a tool call for display */
function formatToolAction(toolName: string, args?: Record<string, unknown>): string {
  const path = args?.file_path ? shortenPath(String(args.file_path)) : "";
  switch (toolName) {
    case "Read": return `Reading ${path}`;
    case "Edit": return `Editing ${path}`;
    case "Write": return `Writing ${path}`;
    case "Bash": {
      const cmd = String(args?.command ?? "").slice(0, 60);
      return `Running: ${cmd}${String(args?.command ?? "").length > 60 ? "..." : ""}`;
    }
    case "Grep": return `Searching for ${args?.pattern ?? "pattern"}`;
    case "Glob": return `Finding files ${args?.pattern ?? ""}`;
    case "Agent": return "Spawning sub-agent";
    default: return `${toolName}${path ? ` ${path}` : ""}`;
  }
}

async function executeSubAgent(
  platform: Platform,
  prompt: string,
  task: PlanTask,
  config: SupipowersConfig,
  ctx?: NotifyCtx,
  progress?: RunProgressState,
  model?: string,
  thinkingLevel?: string | null,
  signal?: AbortSignal,
): Promise<SubAgentResult> {
  if (typeof platform.createAgentSession !== "function") {
    throw new Error(
      "Sub-agent dispatch is not available on this platform. " +
      "If you just updated supipowers, restart your agent session to load the new code.",
    );
  }

  const session = await platform.createAgentSession({
    cwd: process.cwd(),
    taskDepth: 1,
    parentTaskPrefix: `task-${task.id}`,
    ...(model ? { model } : {}),
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
  });

  // Track files changed and emit live progress
  const filesChanged = new Set<string>();
  const FILE_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);
  const pendingToolArgs = new Map<string, Record<string, unknown>>();
  const tag = `Task ${task.id}`;
  let lastThinkingPreview = "";
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update") {
      const msg = event.message as { content?: unknown } | undefined;
      const content = extractTextContent(msg?.content);
      const preview = content.split("\n").filter(Boolean).pop()?.slice(0, 80) ?? "";
      if (preview && preview !== lastThinkingPreview) {
        lastThinkingPreview = preview;
        if (progress) {
          progress.setActivity(task.id, preview);
        } else if (ctx) {
          ctx.ui.notify(`${tag}: thinking — ${preview}`, "info");
        }
      }
    }
    if (event.type === "tool_execution_start") {
      const args = event.args as Record<string, unknown> | undefined;
      if (FILE_TOOLS.has(event.toolName) && args?.file_path) {
        pendingToolArgs.set(event.toolCallId, args);
      }
      if (progress) {
        progress.setActivity(task.id, formatToolAction(event.toolName, args));
        progress.incrementTools(task.id);
      } else if (ctx) {
        ctx.ui.notify(`${tag}: ${formatToolAction(event.toolName, args)}`, "info");
      }
    }
    if (event.type === "tool_execution_end") {
      const args = pendingToolArgs.get(event.toolCallId);
      if (args?.file_path && !event.isError) {
        filesChanged.add(String(args.file_path));
        progress?.incrementFiles(task.id);
      }
      pendingToolArgs.delete(event.toolCallId);
    }
  });

  // Wire abort signal to dispose the session
  let abortHandler: (() => void) | undefined;
  if (signal && !signal.aborted) {
    abortHandler = () => {
      session.dispose().catch(() => {}); // best-effort cleanup
    };
    signal.addEventListener("abort", abortHandler, { once: true });
  }

  try {
    await session.prompt(prompt, { expandPromptTemplates: false });

    // Extract the last assistant message
    const messages = session.state.messages;
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant");

    const lastMsg = lastAssistant as { content?: unknown } | undefined;
    const output = extractTextContent(lastMsg?.content);
    const status = parseAgentStatus(output);

    return {
      status,
      output,
      concerns: status === "done_with_concerns"
        ? extractConcerns(output)
        : undefined,
      filesChanged: [...filesChanged],
    };
  } finally {
    if (abortHandler && signal) {
      signal.removeEventListener("abort", abortHandler);
    }
    unsubscribe();
    await session.dispose().catch(() => {}); // may already be disposed by abort
  }
}

function extractTextContent(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block: { type?: string }) => block.type === "text")
      .map((block: { text?: string }) => block.text ?? "")
      .join("\n");
  }
  return String(content);
}

function parseAgentStatus(output: string): AgentStatus {
  // Look for structured "**Status:** X" or "Status: X" patterns to avoid false positives
  const statusMatch = output.match(/\*?\*?status\*?\*?:\s*(BLOCKED|NEEDS_CONTEXT|DONE_WITH_CONCERNS|DONE)/i);
  if (statusMatch) {
    const val = statusMatch[1].toUpperCase();
    if (val === "BLOCKED" || val === "NEEDS_CONTEXT") return "blocked";
    if (val === "DONE_WITH_CONCERNS") return "done_with_concerns";
    return "done";
  }
  // Default: if agent completed without explicit status, treat as done
  return "done";
}

function extractConcerns(output: string): string {
  const match = output.match(/(?:concerns?|issues?|worries):\s*(.+?)(?:\n\n|$)/is);
  return match?.[1]?.trim() ?? "";
}

/** Review result from a spec compliance or code quality reviewer */
export interface ReviewResult {
  passed: boolean;
  issues: string;
}

/**
 * Dispatch an implementer with 2-stage review (spec compliance + code quality).
 * Follows supipowers' subagent-driven-development pattern:
 * 1. Implementer implements + self-reviews
 * 2. Spec compliance reviewer verifies implementation matches spec
 * 3. If spec issues → re-dispatch implementer with feedback
 * 4. Code quality reviewer checks implementation quality
 * 5. If quality issues → re-dispatch implementer with feedback
 */
export async function dispatchAgentWithReview(
  options: DispatchOptions & { workDir?: string },
): Promise<AgentResult> {
  const { platform, ctx, task, planContext, config, lspAvailable, contextModeAvailable, workDir } = options;
  const maxReviewRetries = config.orchestration.maxFixRetries;

  // Step 1: Dispatch implementer
  let implementResult = await dispatchAgent(options);

  // If blocked or needs context, skip reviews
  if (implementResult.status === "blocked") {
    return implementResult;
  }

  // Check abort before reviews
  if (options.signal?.aborted) return implementResult;

  // Step 2: Spec compliance review
  options.progress?.setStatus(task.id, "reviewing");
  for (let attempt = 0; attempt <= maxReviewRetries; attempt++) {
    const specReview = await dispatchSpecReview(
      platform,
      task,
      implementResult,
      config,
    );

    if (specReview.passed) {
      notifyInfo(ctx, `Task ${task.id} spec review passed`);
      break;
    }

    if (attempt === maxReviewRetries) {
      notifyWarning(
        ctx,
        `Task ${task.id} spec review failed after ${maxReviewRetries + 1} attempts`,
        specReview.issues,
      );
      implementResult.status = "done_with_concerns";
      implementResult.concerns = `Spec compliance issues: ${specReview.issues}`;
      return implementResult;
    }

    // Re-dispatch implementer with spec review feedback
    notifyInfo(
      ctx,
      `Task ${task.id} spec issues found, re-dispatching`,
      specReview.issues,
    );
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

  // Check abort before quality review
  if (options.signal?.aborted) return implementResult;

  // Step 3: Code quality review
  options.progress?.setStatus(task.id, "reviewing");
  for (let attempt = 0; attempt <= maxReviewRetries; attempt++) {
    const qualityReview = await dispatchQualityReview(
      platform,
      task,
      implementResult,
      config,
    );

    if (qualityReview.passed) {
      notifyInfo(ctx, `Task ${task.id} quality review passed`);
      break;
    }

    if (attempt === maxReviewRetries) {
      notifyWarning(
        ctx,
        `Task ${task.id} quality review failed after ${maxReviewRetries + 1} attempts`,
        qualityReview.issues,
      );
      implementResult.status = "done_with_concerns";
      implementResult.concerns = `Code quality issues: ${qualityReview.issues}`;
      return implementResult;
    }

    // Re-dispatch implementer with quality review feedback
    notifyInfo(
      ctx,
      `Task ${task.id} quality issues found, re-dispatching`,
      qualityReview.issues,
    );
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
  platform: Platform,
  task: PlanTask,
  implementResult: AgentResult,
  config: SupipowersConfig,
): Promise<ReviewResult> {
  const prompt = buildSpecComplianceReviewPrompt({
    taskRequirements: `Task: ${task.name}\n\n${task.description}\n\nAcceptance Criteria: ${task.criteria}`,
    implementerReport: implementResult.output,
  });

  const modelConfig = loadModelConfig(platform.paths, process.cwd());
  const bridge = createModelBridge(platform);
  const candidates = resolveAllCandidates("spec-reviewer", modelRegistry, modelConfig, bridge);
  const resolved = candidates[0] ?? { model: undefined, thinkingLevel: null, source: "main" as const };

  try {
    const result = await executeSubAgent(platform, prompt, task, config, undefined, undefined, resolved.model, resolved.thinkingLevel);
    const passed =
      result.status === "done" ||
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
  platform: Platform,
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

  const modelConfig = loadModelConfig(platform.paths, process.cwd());
  const bridge = createModelBridge(platform);
  const candidates = resolveAllCandidates("quality-reviewer", modelRegistry, modelConfig, bridge);
  const resolved = candidates[0] ?? { model: undefined, thinkingLevel: null, source: "main" as const };

  try {
    const result = await executeSubAgent(platform, prompt, task, config, undefined, undefined, resolved.model, resolved.thinkingLevel);
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
  options: DispatchOptions & { previousOutput: string; failureReason: string },
): Promise<AgentResult> {
  const { platform, ctx, task, config, lspAvailable, contextModeAvailable, previousOutput, failureReason, progress } =
    options;
  const startTime = Date.now();

  const prompt = buildFixPrompt(
    task,
    previousOutput,
    failureReason,
    lspAvailable,
    contextModeAvailable,
  );

  progress?.setStatus(task.id, "running");

  // Build fallback chain just like dispatchAgent
  const modelConfig = loadModelConfig(platform.paths, ctx.cwd);
  const bridge = createModelBridge(platform);
  const candidates = resolveAllCandidates(
    options.actionId ?? "fix-agent",
    modelRegistry,
    modelConfig,
    bridge,
  );

  if (options.parentSessionModel) {
    const alreadyPresent = candidates.some((c) => c.model === options.parentSessionModel);
    if (!alreadyPresent) {
      candidates.push({ model: options.parentSessionModel, thinkingLevel: null, source: "main" });
    }
  }

  if (candidates.length === 0) {
    candidates.push({ model: undefined, thinkingLevel: null, source: "main" });
  }

  let lastError: unknown = null;

  for (const candidate of candidates) {
    try {
      const result = await executeSubAgent(platform, prompt, task, config, ctx, progress, candidate.model, candidate.thinkingLevel);
      return {
        taskId: task.id,
        status: result.status,
        output: result.output,
        concerns: result.concerns,
        filesChanged: result.filesChanged,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      lastError = error;
      if (!isModelAuthError(error)) break;
    }
  }

  return {
    taskId: task.id,
    status: "blocked",
    output: friendlyErrorMessage(lastError),
    filesChanged: [],
    duration: Date.now() - startTime,
  };
}
