import type { Platform } from "../platform/types.js";
import type { DebugLogger } from "../debug/logger.js";
import type { Plan, ResolvedModel } from "../types.js";
import type { PlanningSystemPromptOptions } from "./system-prompt.js";
import { applyModelOverride } from "../config/model-resolver.js";
import { listPlans, parsePlan, readPlanFile } from "../storage/plans.js";
import { validatePlanMarkdown } from "./validate.js";
import { getProjectStatePath } from "../workspace/state-paths.js";
import * as path from "node:path";
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
 * Mirrors OMP 14.5.11+'s `todo_write` payload shape just enough to hand the
 * agent a ready-to-execute payload after plan approval.
 *
 * The canonical schema lives in OMP \u2014 keep this type local; we only construct
 * the payload to embed in a prompt string. Task identity is the task content
 * verbatim; later progress updates (`start`/`done`/`note`) refer to that exact
 * string, not synthetic ids.
 */
type TodoWriteOp =
  | {
      op: "init";
      list: Array<{ phase: string; items: string[] }>;
    }
  | { op: "note"; task: string; text: string };

/** Cap individual task labels so the embedded payload stays bounded. */
const TODO_WRITE_TASK_LABEL_MAX_CHARS = 200;

/**
 * Single phase name supipowers' planner emits today. Imported into the
 * execution prompt so the prose stays in lock-step with the JSON payload \u2014
 * change here and `buildExecutionPrompt` follows automatically.
 */
const PLAN_PHASE_NAME = "Implementation";

function truncateTaskLabel(label: string): string {
  if (label.length <= TODO_WRITE_TASK_LABEL_MAX_CHARS) return label;
  return `${label.slice(0, TODO_WRITE_TASK_LABEL_MAX_CHARS - 1).trimEnd()}\u2026`;
}

function appendTaskLabelOrdinal(label: string, ordinal: number): string {
  const suffix = ` (${ordinal})`;
  if (label.length + suffix.length <= TODO_WRITE_TASK_LABEL_MAX_CHARS) {
    return `${label}${suffix}`;
  }
  const prefixMax = TODO_WRITE_TASK_LABEL_MAX_CHARS - suffix.length - 1;
  return `${label.slice(0, prefixMax).trimEnd()}\u2026${suffix}`;
}

function uniqueTaskLabels(names: string[]): string[] {
  const used = new Set<string>();
  const nextOrdinalByBase = new Map<string, number>();
  return names.map((name) => {
    const base = truncateTaskLabel(name);
    let label = base;
    if (used.has(label)) {
      let ordinal = nextOrdinalByBase.get(base) ?? 2;
      do {
        label = appendTaskLabelOrdinal(base, ordinal);
        ordinal += 1;
      } while (used.has(label));
      nextOrdinalByBase.set(base, ordinal);
    } else {
      nextOrdinalByBase.set(base, 2);
    }
    used.add(label);
    return label;
  });
}

/**
 * Build the canonical `todo_write` ops payload from a parsed plan.
 *
 * Empty plans return `{ ops: [] }` so callers can skip emit cleanly.
 * Non-empty plans always start with a single `init` op containing one phase
 * (`Implementation`) whose `items` is one task content string per `plan.tasks`
 * entry. Task names are truncated and de-duplicated before they become todo
 * identities. Tasks that carry acceptance criteria get a follow-up `note` op
 * whose `task` field is the exact item label, keeping note targets in lock-step
 */
export function buildTodoWriteOpsForPlan(plan: Plan): { ops: TodoWriteOp[] } {
  if (plan.tasks.length === 0) return { ops: [] };

  const items = uniqueTaskLabels(plan.tasks.map((task) => task.name));

  const ops: TodoWriteOp[] = [
    {
      op: "init",
      list: [{ phase: PLAN_PHASE_NAME, items }],
    },
  ];

  for (const [index, task] of plan.tasks.entries()) {
    const trimmed = task.criteria.trim();
    if (!trimmed) continue;
    // Note targets MUST equal the item label verbatim \u2014 task identity is the
    // task content string, never a synthetic id.
    ops.push({ op: "note", task: items[index], text: trimmed });
  }

  return { ops };
}

/**
 * Build the execution handoff prompt from an approved plan.
 *
 * Mirrors OMP's `plan-mode-approved.md` template: critical directive
 * to execute, the full plan content, and step-by-step instructions.
 *
 * When `plan` is provided and has tasks, the prompt also embeds the
 * exact `todo_write` payload the agent must call before doing any work.
 */
export function buildExecutionPrompt(
  planContent: string,
  planPath: string,
  plan?: Plan,
): string {
  const todoBlock: string[] = [];
  if (plan && plan.tasks.length > 0) {
    const payload = buildTodoWriteOpsForPlan(plan);
    const initOp = payload.ops.find(
      (op): op is Extract<TodoWriteOp, { op: "init" }> => op.op === "init",
    );
    const phaseName = initOp?.list[0]?.phase ?? PLAN_PHASE_NAME;
    todoBlock.push(
      "",
      "## Initialize todo tracker",
      "",
      "Before any other work, call `todo_write` with exactly this payload:",
      "",
      "```json",
      JSON.stringify(payload, null, 2),
      "```",
      "",
      `Task identity is the task content verbatim. Later progress updates (\`start\`, \`done\`, \`note\`) MUST pass \`task\` equal to the exact item string above; phase updates MUST pass \`phase: "${phaseName}"\`. Mark the first task \`in_progress\` and proceed.`,
    );
  }

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
    "</instruction>",
    ...todoBlock,
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
  plan: Plan | null,
 ): Promise<void> {
  const prompt = buildExecutionPrompt(planContent, planPath, plan ?? undefined);
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
        `The plan you just wrote to \`${path.join(getProjectStatePath(platform.paths, planCwd, "plans"), planName)}\` does not match the required schema.`,
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
    const planPath = path.join(getProjectStatePath(platform.paths, planCwd, "plans"), planName);
    let parsedPlan: Plan | null = null;
    try {
      parsedPlan = parsePlan(planContent, planPath);
    } catch (error) {
      debugLogger?.log("approval_flow_plan_parse_failed", {
        planName,
        planPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
        parsedPlan,
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
        parsedPlan,
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
