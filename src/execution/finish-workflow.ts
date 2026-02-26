import { transitionState } from "../engine/state-machine";
import { evaluateVerificationGate } from "../quality/verification-gate";
import { writeFinalReport } from "../reports/final-report";
import type { Strictness, WorkflowState } from "../types";

export type FinishMode = "merge" | "pr" | "keep" | "discard";

export interface FinishWorkflowInput {
  cwd: string;
  state: WorkflowState;
  strictness: Strictness;
  mode: FinishMode;
  markReviewPass: boolean;
}

export interface FinishWorkflowResult {
  ok: boolean;
  state: WorkflowState;
  message: string;
  reportPath?: string;
}

export function parseFinishArgs(args: string): { mode: FinishMode; markReviewPass: boolean } {
  const tokens = args
    .trim()
    .split(/\s+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 0);

  const mode =
    tokens.find((token): token is FinishMode => ["merge", "pr", "keep", "discard"].includes(token)) ?? "keep";
  const markReviewPass = tokens.includes("--review-pass") || tokens.includes("--approve-review");

  return { mode, markReviewPass };
}

function finishNextAction(mode: FinishMode, reportPath: string): string {
  if (mode === "merge") return `Workflow merged. Final report: ${reportPath}`;
  if (mode === "pr") return `Workflow prepared for PR. Final report: ${reportPath}`;
  if (mode === "discard") return `Workflow discarded after review. Final report: ${reportPath}`;
  return `Workflow completed and kept locally. Final report: ${reportPath}`;
}

export function finishWorkflow(input: FinishWorkflowInput): FinishWorkflowResult {
  if (input.state.phase !== "review_pending" && input.state.phase !== "ready_to_finish") {
    return {
      ok: false,
      state: input.state,
      message: `Cannot finish from phase '${input.state.phase}'. Move workflow to review_pending first.`,
    };
  }

  let working = input.state;
  if (input.markReviewPass) {
    working = {
      ...working,
      checkpoints: {
        ...working.checkpoints,
        hasReviewPass: true,
      },
      updatedAt: Date.now(),
    };
  }

  const verification = evaluateVerificationGate({
    cwd: input.cwd,
    state: working,
    strictness: input.strictness,
    stage: "pre_finish",
  });

  if (verification.blocking) {
    return {
      ok: false,
      state: {
        ...working,
        phase: "blocked",
        blocker: verification.summary,
        nextAction: verification.nextActions[0] ?? "Resolve blocking quality gates before finishing.",
        updatedAt: Date.now(),
      },
      message: `${verification.summary}\n${verification.nextActions.join("\n")}`.trim(),
    };
  }

  if (working.phase === "review_pending") {
    const toReady = transitionState(working, {
      to: "ready_to_finish",
      strictness: input.strictness,
      checkpoints: working.checkpoints,
      nextAction: "Finishing workflow",
    });

    if (!toReady.ok) {
      return {
        ok: false,
        state: toReady.state,
        message: `Unable to enter ready_to_finish: ${toReady.reason}`,
      };
    }

    working = toReady.state;
  }

  const toCompleted = transitionState(working, {
    to: "completed",
    strictness: input.strictness,
    checkpoints: working.checkpoints,
    nextAction: "Workflow completed",
  });

  if (!toCompleted.ok) {
    return {
      ok: false,
      state: toCompleted.state,
      message: `Unable to complete workflow: ${toCompleted.reason}`,
    };
  }

  const reportPath = writeFinalReport(input.cwd, {
    finishMode: input.mode,
    state: toCompleted.state,
    revalidation: verification,
  });

  const finalState = {
    ...toCompleted.state,
    nextAction: finishNextAction(input.mode, reportPath),
    updatedAt: Date.now(),
  };

  return {
    ok: true,
    state: finalState,
    message: `Workflow finished using mode '${input.mode}'. Report: ${reportPath}`,
    reportPath,
  };
}
