import type { Platform } from "../platform/types.js";
import type { DebugLogger } from "../debug/logger.js";
import type { ResolvedModel } from "../types.js";
import type { PlanningSystemPromptOptions } from "./system-prompt.js";
import { applyModelOverride } from "../config/model-resolver.js";
import { listPlans, readPlanFile } from "../storage/plans.js";
import { validatePlanMarkdown } from "./validate.js";
import { appendReliabilityRecord } from "../storage/reliability-metrics.js";

/**
 * Plan approval flow state.
 *
 * After `/supi:plan` sends the planning steer, this module tracks the
 * planning session. When the agent finishes a turn, we detect newly
 * written plan files and show an approval UI — mirroring OMP's native
 * `/plan` approval experience.
 */
let planningActive = false;
let plansBefore: string[] = [];
let planCwd: string = "";
/** newSession function captured from the command context at plan start. */
let capturedNewSession: ((options?: any) => Promise<{ cancelled: boolean }>) | null = null;
/** Resolved model for plan action — re-applied on execution handoff. */
let capturedResolvedModel: ResolvedModel | null = null;
/** Guards against concurrent approval prompts from rapid agent_end events. */
let approvalPending = false;
/** Planning-system-prompt options captured from the command context at plan start. */
let planningPromptOptions: PlanningSystemPromptOptions | null = null;
/** Active debug logger for the current planning session. */
let planningDebugLogger: DebugLogger | null = null;

/** Mark planning as started (called by plan command after sending steer). */
export function startPlanTracking(
  cwd: string,
  paths: any,
  newSession?: (options?: any) => Promise<{ cancelled: boolean }>,
  resolvedModel?: ResolvedModel,
  promptOptions?: PlanningSystemPromptOptions,
  debugLogger?: DebugLogger,
 ): void {
  planningActive = true;
  planCwd = cwd;
  plansBefore = listPlans(paths, cwd);
  capturedNewSession = newSession ?? null;
  capturedResolvedModel = resolvedModel ?? null;
  planningPromptOptions = promptOptions ?? null;
  planningDebugLogger = debugLogger ?? null;
  approvalPending = false;

  planningDebugLogger?.log("planning_tracking_started", {
    cwd,
    existingPlanCount: plansBefore.length,
    hasNewSession: Boolean(newSession),
    hasResolvedModel: Boolean(resolvedModel),
    promptOptions: promptOptions ?? null,
  });
}

/** Cancel plan tracking (e.g., session change). */
export function cancelPlanTracking(): void {
  planningActive = false;
  plansBefore = [];
  planCwd = "";
  capturedNewSession = null;
  capturedResolvedModel = null;
  planningPromptOptions = null;
  planningDebugLogger = null;
  approvalPending = false;
}

/** Whether a planning session is currently active. */
export function isPlanningActive(): boolean {
  return planningActive;
}

export function getPlanningPromptOptions(): PlanningSystemPromptOptions | null {
  return planningPromptOptions;
}

export function getPlanningDebugLogger(): DebugLogger | null {
  return planningDebugLogger;
}

/**
 * Build the execution handoff prompt from an approved plan.
 *
 * Mirrors OMP's `plan-mode-approved.md` template: critical directive
 * to execute, the full plan content, and step-by-step instructions.
 */
function buildExecutionPrompt(planContent: string, planPath: string): string {
  return [
    "<critical>",
    "Plan approved. You **MUST** execute it now.",
    "</critical>",
    "",
    `Finalized plan: \`${planPath}\``,
    "",
    "## Plan",
    "",
    planContent,
    "",
    "<instruction>",
    `You **MUST** execute this plan step by step from \`${planPath}\`.`,
    "You **MUST** verify each step before proceeding to the next.",
    "Before execution, you **MUST** initialize todo tracking with the task list.",
    "After each completed step, immediately update progress so it stays visible.",
    "</instruction>",
    "",
    "<critical>",
    "You **MUST** keep going until complete. This matters.",
    "</critical>",
  ].join("\n");
}

/**
 * Execute the approve-and-execute flow.
 *
 * Clears the current session via ctx.newSession() (gives a clean slate),
 * then sends the execution prompt as a user message so the agent picks it
 * up immediately in the new session.
 *
 * Falls back to same-session steer when ctx.newSession is unavailable
 * (headless / SDK environments that don't expose the session API).
 */
async function executeApproveFlow(
  platform: Platform,
  ctx: any,
  planContent: string,
  planPath: string,
  newSession: ((options?: any) => Promise<{ cancelled: boolean }>) | null,
  resolvedModel: ResolvedModel | null,
  debugLogger: DebugLogger | null,
 ): Promise<void> {
  const prompt = buildExecutionPrompt(planContent, planPath);
  debugLogger?.log("execution_handoff_started", {
    planPath,
    promptLength: prompt.length,
    usesNewSession: Boolean(newSession),
  });

  // Re-apply the plan model override for the execution turn.
  // The planning turn's restore hook already fired (model reverted to default).
  // We must switch again so the execution LLM turn uses the configured model.
  if (resolvedModel) {
    await applyModelOverride(platform, ctx, "plan", resolvedModel);
    debugLogger?.log("execution_handoff_model_override_applied", {
      configuredAction: "plan",
    });
  }

  if (newSession) {
    const result = await newSession();
    if (result?.cancelled) {
      debugLogger?.log("execution_handoff_new_session_cancelled", {
        planPath,
      });
      ctx.ui.notify("Session start cancelled. Plan saved; run /supi:plan again to execute.");
      return;
    }
    platform.sendUserMessage(prompt);
    debugLogger?.log("execution_handoff_user_message_sent", {
      planPath,
    });
  } else {
    // Fallback: headless/SDK mode — steer in the current session.
    platform.sendMessage(
      {
        customType: "supi-plan-execute",
        content: [{ type: "text", text: prompt }],
        display: "none",
      },
      { deliverAs: "steer", triggerTurn: true },
    );
    debugLogger?.log("execution_handoff_same_session_steer_sent", {
      planPath,
    });
    ctx.ui.notify("Plan approved — starting execution");
  }
}

/**
 * Register the agent_end hook that drives the plan approval UI.
 *
 * After the planning agent finishes each turn, detect if a new plan
 * file appeared and show an approval selector:
 *   - "Approve and execute" → clear session, send execution prompt
 *   - "Refine plan"        → let user type refinement (empty = approve)
 *   - "Stay in plan mode"  → cancel tracking, return control
 */
export function registerPlanApprovalHook(platform: Platform): void {
  platform.on("agent_end", async (_event: any, ctx: any) => {
    if (!planningActive || !ctx?.hasUI || approvalPending) return;

    // Detect newly written plan files
    const plansNow = listPlans(platform.paths, planCwd);
    const newPlans = plansNow.filter((p) => !plansBefore.includes(p));

    if (newPlans.length === 0) {
      // No new plan yet — agent is still exploring/asking questions.
      // Update snapshot so we detect the plan on a future turn.
      plansBefore = plansNow;
      return;
    }

    // Pick the most recent new plan
    const planName = newPlans[newPlans.length - 1];
    const planContent = readPlanFile(platform.paths, planCwd, planName);
    const debugLogger = planningDebugLogger;
    if (!planContent) {
      debugLogger?.log("approval_flow_plan_content_missing", {
        planName,
      });
      return;
    }

    // Schema-first validation: the plan must parse into a valid PlanSpec.
    // Invalid plans trigger a retry steer — no approval UI until the agent
    // produces an artifact whose task list matches the PlanSpec contract.
    //
    // We validate but do NOT canonicalize the on-disk file. Today's plan
    // writer produces rich markdown (architecture, per-task TDD steps) that
    // the parser intentionally does not capture. Rewriting the file from the
    // parsed PlanSpec would strip that structure. The schema is the
    // validation gate; markdown stays the user-visible form until a future
    // phase lifts the agent to write PlanSpec directly.
    const validated = validatePlanMarkdown(planContent, planName);
    if (!validated.output) {
      debugLogger?.log("approval_flow_plan_invalid", {
        planName,
        error: validated.error,
        errors: validated.errors,
      });
      try {
        appendReliabilityRecord(platform.paths, planCwd, {
          ts: new Date().toISOString(),
          command: "plan",
          operation: "plan-spec",
          outcome: "blocked",
          attempts: 1,
          reason: validated.error ?? "Plan validation failed.",
          cwd: planCwd,
        });
      } catch {}
      plansBefore = plansNow;
      const steer = [
        `The plan you just wrote to \`${platform.paths.dotDirDisplay}/supipowers/plans/${planName}\` does not match the required schema.`,
        "",
        "Validation errors:",
        ...validated.errors.map((err) => `- ${err.path}: ${err.message}`),
        "",
        "Fix the plan and rewrite the file so every task includes id, name, files, criteria, and complexity (small|medium|large).",
      ].join("\n");
      platform.sendMessage(
        {
          customType: "supi-plan-invalid",
          content: [{ type: "text", text: steer }],
          display: "none",
        },
        { deliverAs: "steer", triggerTurn: true },
      );
      return;
    }

    const canonicalContent = planContent;
    const planPath = `${platform.paths.dotDirDisplay}/supipowers/plans/${planName}`;
    try {
      appendReliabilityRecord(platform.paths, planCwd, {
        ts: new Date().toISOString(),
        command: "plan",
        operation: "plan-spec",
        outcome: "ok",
        attempts: 1,
        cwd: planCwd,
      });
    } catch {}
    const approvalOptions = [
      "Approve and execute",
      "Refine plan",
      "Stay in plan mode",
    ];

    approvalPending = true;
    debugLogger?.log("approval_flow_presented", {
      planName,
      planPath,
      options: approvalOptions,
    });
    const choice = await ctx.ui.select("Plan complete — what next?", approvalOptions);
    approvalPending = false;
    debugLogger?.log("approval_flow_choice", {
      choice: choice ?? null,
      planPath,
    });

    if (choice === "Approve and execute") {
      const executionNewSession = capturedNewSession;
      const executionModel = capturedResolvedModel;
      cancelPlanTracking();
      await executeApproveFlow(
        platform,
        ctx,
        canonicalContent,
        planPath,
        executionNewSession,
        executionModel,
        debugLogger,
      );
    } else if (choice === "Refine plan") {
      // Keep planning active, let user type refinement.
      // Empty input is treated as misclick → fall through to approve.
      plansBefore = plansNow;
      const refinement = await ctx.ui.input("What should be refined?");
      if (!refinement || !refinement.trim()) {
        // Misclick: treat empty input as approval
        debugLogger?.log("approval_flow_empty_refinement_treated_as_approve", {
          planPath,
        });
        const executionNewSession = capturedNewSession;
        const executionModel = capturedResolvedModel;
        cancelPlanTracking();
        await executeApproveFlow(
        platform,
        ctx,
        canonicalContent,
        planPath,
        executionNewSession,
        executionModel,
        debugLogger,
      );
      } else {
        debugLogger?.log("approval_flow_refine_requested", {
          planPath,
          refinementLength: refinement.length,
        });
        ctx.ui.setEditorText?.(refinement);
      }
    } else if (choice === "Stay in plan mode") {
      // Explicit user choice — cancel tracking, return control
      debugLogger?.log("planning_tracking_cancelled", {
        reason: "stay_in_plan_mode",
        planPath,
      });
      cancelPlanTracking();
      ctx.ui.notify("Planning complete. Plan saved but not executing.");
    } else {
      // Select was cancelled (returned undefined/null) — likely because a new
      // agent turn started (e.g., background job completion). Don't cancel
      // tracking; the next agent_end will re-prompt.
      debugLogger?.log("approval_flow_choice_cancelled", {
        planPath,
      });
    }
  });
}
