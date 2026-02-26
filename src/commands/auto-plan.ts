import { existsSync } from "node:fs";
import { transitionState } from "../engine/state-machine";
import { writePlanArtifact } from "../storage/artifacts";
import type { Strictness, WorkflowPhase, WorkflowState } from "../types";

export interface AutoPlanEvent {
  type: "workflow_started" | "design_approved" | "plan_ready";
  phase: WorkflowPhase;
  meta?: Record<string, unknown>;
}

export interface AutoPlanResult {
  ok: boolean;
  state: WorkflowState;
  message: string;
  events: AutoPlanEvent[];
}

function fail(state: WorkflowState, message: string): AutoPlanResult {
  return { ok: false, state, message, events: [] };
}

export function autoAdvanceToPlanReady(
  cwd: string,
  state: WorkflowState,
  strictness: Strictness,
  objective?: string,
): AutoPlanResult {
  let working: WorkflowState = {
    ...state,
    checkpoints: { ...state.checkpoints },
  };

  const providedObjective = objective?.trim();
  if (providedObjective) {
    working = {
      ...working,
      objective: providedObjective,
    };
  }

  if (!working.objective) {
    return fail(working, "Objective is required. Run /sp-start <objective>.");
  }

  const objectiveChanged = Boolean(providedObjective && providedObjective !== state.objective);
  if (objectiveChanged) {
    if (state.phase === "executing" || state.phase === "review_pending" || state.phase === "ready_to_finish") {
      return fail(
        working,
        `Cannot replace objective while workflow is in '${state.phase}'. Finish or reset first.`,
      );
    }

    working = {
      ...working,
      phase: "idle",
      blocker: undefined,
      nextAction: "Auto-advancing workflow to a ready plan",
      planArtifactPath: undefined,
      checkpoints: {
        hasDesignApproval: false,
        hasPlanArtifact: false,
        hasReviewPass: false,
      },
      updatedAt: Date.now(),
    };
  }

  const events: AutoPlanEvent[] = [];
  let createdPlanPath: string | undefined;
  let guard = 0;

  while (working.phase !== "plan_ready" && guard < 16) {
    guard += 1;

    if (working.phase === "completed" || working.phase === "aborted") {
      const toIdle = transitionState(working, {
        to: "idle",
        strictness,
        checkpoints: working.checkpoints,
        nextAction: "Start a new workflow",
      });

      if (!toIdle.ok) {
        return fail(toIdle.state, `Supipowers could not reset workflow: ${toIdle.reason}`);
      }

      working = toIdle.state;
      continue;
    }

    if (working.phase === "blocked") {
      const toPlanning = transitionState(working, {
        to: "planning",
        strictness,
        checkpoints: working.checkpoints,
        nextAction: "Recovering workflow and preparing plan",
      });

      if (!toPlanning.ok) {
        return fail(toPlanning.state, `Supipowers could not recover from blocked state: ${toPlanning.reason}`);
      }

      working = toPlanning.state;
      continue;
    }

    if (working.phase === "idle") {
      const toBrainstorming = transitionState(working, {
        to: "brainstorming",
        strictness,
        checkpoints: working.checkpoints,
        nextAction: "Auto-advancing workflow to a ready plan",
      });

      if (!toBrainstorming.ok) {
        return fail(toBrainstorming.state, `Supipowers start blocked: ${toBrainstorming.reason}`);
      }

      working = toBrainstorming.state;
      events.push({ type: "workflow_started", phase: working.phase, meta: { objective: working.objective } });
      continue;
    }

    if (working.phase === "brainstorming") {
      const toPending = transitionState(working, {
        to: "design_pending_approval",
        strictness,
        checkpoints: working.checkpoints,
        nextAction: "Auto-approving design",
      });

      if (!toPending.ok) {
        return fail(toPending.state, `Supipowers design checkpoint blocked: ${toPending.reason}`);
      }

      working = toPending.state;
      continue;
    }

    if (working.phase === "design_pending_approval") {
      const withApproval = {
        ...working,
        checkpoints: {
          ...working.checkpoints,
          hasDesignApproval: true,
        },
      };

      const toApproved = transitionState(withApproval, {
        to: "design_approved",
        strictness,
        checkpoints: withApproval.checkpoints,
        nextAction: "Design approved automatically. Generating plan",
      });

      if (!toApproved.ok) {
        return fail(toApproved.state, `Supipowers design approval blocked: ${toApproved.reason}`);
      }

      working = toApproved.state;
      events.push({ type: "design_approved", phase: working.phase });
      continue;
    }

    if (working.phase === "design_approved") {
      const toPlanning = transitionState(working, {
        to: "planning",
        strictness,
        checkpoints: working.checkpoints,
        nextAction: "Generating implementation plan",
      });

      if (!toPlanning.ok) {
        return fail(toPlanning.state, `Supipowers planning blocked: ${toPlanning.reason}`);
      }

      working = toPlanning.state;
      continue;
    }

    if (working.phase === "planning") {
      const existingPlanPath = working.planArtifactPath && existsSync(working.planArtifactPath)
        ? working.planArtifactPath
        : undefined;
      const planPath = existingPlanPath ?? writePlanArtifact(cwd, working.objective ?? "");
      if (!existingPlanPath) createdPlanPath = planPath;

      const withPlan = {
        ...working,
        planArtifactPath: planPath,
        checkpoints: {
          ...working.checkpoints,
          hasPlanArtifact: true,
        },
      };

      const toReady = transitionState(withPlan, {
        to: "plan_ready",
        strictness,
        checkpoints: withPlan.checkpoints,
        nextAction: "Run /sp-execute to execute now or continue later",
      });

      if (!toReady.ok) {
        return fail(toReady.state, `Supipowers plan blocked: ${toReady.reason}`);
      }

      working = toReady.state;
      events.push({ type: "plan_ready", phase: working.phase, meta: { planPath } });
      continue;
    }

    if (working.phase === "executing" || working.phase === "review_pending" || working.phase === "ready_to_finish") {
      return fail(
        working,
        `Workflow is already in '${working.phase}'. Complete or reset this run before starting a new one.`,
      );
    }

    return fail(working, `Cannot auto-advance from phase '${working.phase}'.`);
  }

  if (working.phase !== "plan_ready") {
    return fail(working, "Supipowers could not auto-prepare plan (guard reached).");
  }

  if (createdPlanPath) {
    return {
      ok: true,
      state: working,
      events,
      message: `Plan generated instantly at ${createdPlanPath}.`,
    };
  }

  return {
    ok: true,
    state: working,
    events,
    message: `Plan is ready at ${working.planArtifactPath ?? "(not specified)"}.`,
  };
}
