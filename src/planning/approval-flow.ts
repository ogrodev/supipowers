import type { Platform } from "../platform/types.js";
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

/** Mark planning as started (called by plan command after sending steer). */
export function startPlanTracking(cwd: string, paths: any): void {
  planningActive = true;
  planCwd = cwd;
  plansBefore = listPlans(paths, cwd);
}

/** Cancel plan tracking (e.g., session change). */
export function cancelPlanTracking(): void {
  planningActive = false;
  plansBefore = [];
  planCwd = "";
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
    "You **MUST** keep going until complete.",
    "</critical>",
  ].join("\n");
}

/**
 * Register the agent_end hook that drives the plan approval UI.
 *
 * After the planning agent finishes each turn, detect if a new plan
 * file appeared and show an approval selector:
 *   - "Approve and execute" → send execution steer
 *   - "Refine plan"        → let user type refinement
 *   - "Done (don't execute)" → cancel tracking
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

    // Show approval UI
    const choice = await ctx.ui.select("Plan complete — what next?", [
      "Approve and execute",
      "Refine plan",
      "Done (don't execute)",
    ]);

    if (choice === "Approve and execute") {
      planningActive = false;
      plansBefore = [];

      const planPath = `${platform.paths.dotDirDisplay}/supipowers/plans/${planName}`;
      const prompt = buildExecutionPrompt(planContent, planPath);

      platform.sendMessage(
        {
          customType: "supi-plan-execute",
          content: [{ type: "text", text: prompt }],
          display: "none",
        },
        { deliverAs: "steer", triggerTurn: true },
      );

      ctx.ui.notify("Plan approved — starting execution");
    } else if (choice === "Refine plan") {
      // Keep planning active, let user type refinement
      plansBefore = plansNow; // Update snapshot
      const refinement = await ctx.ui.input("What should be refined?");
      if (refinement) {
        ctx.ui.setEditorText?.(refinement);
      }
    } else {
      // Done without executing
      cancelPlanTracking();
      ctx.ui.notify("Planning complete. Plan saved but not executing.");
    }
  });
}
