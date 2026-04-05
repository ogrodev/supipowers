import type { Platform } from "../platform/types.js";
import type { ResolvedModel } from "../types.js";
import { applyModelOverride } from "../config/model-resolver.js";
import { listPlans, readPlanFile } from "../storage/plans.js";

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

/** Mark planning as started (called by plan command after sending steer). */
export function startPlanTracking(
  cwd: string,
  paths: any,
  newSession?: (options?: any) => Promise<{ cancelled: boolean }>,
  resolvedModel?: ResolvedModel,
): void {
  planningActive = true;
  planCwd = cwd;
  plansBefore = listPlans(paths, cwd);
  capturedNewSession = newSession ?? null;
  capturedResolvedModel = resolvedModel ?? null;
}

/** Cancel plan tracking (e.g., session change). */
export function cancelPlanTracking(): void {
  planningActive = false;
  plansBefore = [];
  planCwd = "";
  capturedNewSession = null;
  capturedResolvedModel = null;
}

/** Whether a planning session is currently active. */
export function isPlanningActive(): boolean {
  return planningActive;
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
): Promise<void> {
  const prompt = buildExecutionPrompt(planContent, planPath);

  // Re-apply the plan model override for the execution turn.
  // The planning turn's restore hook already fired (model reverted to default).
  // We must switch again so the execution LLM turn uses the configured model.
  if (capturedResolvedModel) {
    await applyModelOverride(platform, ctx, capturedResolvedModel);
  }

  if (capturedNewSession) {
    const result = await capturedNewSession();
    if (result?.cancelled) {
      ctx.ui.notify("Session start cancelled. Plan saved; run /supi:plan again to execute.");
      return;
    }
    platform.sendUserMessage(prompt);
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
    if (!planningActive || !ctx?.hasUI) return;

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
    if (!planContent) return;

    const planPath = `${platform.paths.dotDirDisplay}/supipowers/plans/${planName}`;

    const choice = await ctx.ui.select("Plan complete — what next?", [
      "Approve and execute",
      "Refine plan",
      "Stay in plan mode",
    ]);

    if (choice === "Approve and execute") {
      planningActive = false;
      plansBefore = [];
      await executeApproveFlow(platform, ctx, planContent, planPath);
    } else if (choice === "Refine plan") {
      // Keep planning active, let user type refinement.
      // Empty input is treated as misclick → fall through to approve.
      plansBefore = plansNow;
      const refinement = await ctx.ui.input("What should be refined?");
      if (!refinement || !refinement.trim()) {
        // Misclick: treat empty input as approval
        planningActive = false;
        plansBefore = [];
        await executeApproveFlow(platform, ctx, planContent, planPath);
      } else {
        ctx.ui.setEditorText?.(refinement);
      }
    } else {
      // Stay in plan mode — user keeps control, tracking cancelled
      cancelPlanTracking();
      ctx.ui.notify("Planning complete. Plan saved but not executing.");
    }
  });
}
