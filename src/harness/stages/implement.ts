/**
 * IMPLEMENT stage runner.
 *
 * Counts the tasks in the approved plan and decides whether to run them in-session (steer
 * loop, mirrors `/supi:plan`) or to hand off to `/supi:ultraplan` batch / worktree
 * runtime. The threshold is configurable via `harness.implement_in_session_threshold`
 * (default 10).
 *
 * The actual execution loop lives in the command handler — the stage runner records the
 * routing decision and validates pre-conditions (clean git tree, plan readable, etc.).
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { Plan } from "../../types.js";
import { parsePlan } from "../../storage/plans.js";
import {
  type HarnessStageRunResult,
  type HarnessStageRunner,
  type HarnessStageRunnerContext,
  nowIso,
} from "../stage-runner.js";
import {
  appendImplementLog,
} from "../storage.js";

const DEFAULT_IN_SESSION_THRESHOLD = 10;

export type ImplementRouting = "in-session" | "batch";

export interface ImplementStageInput {
  /** Path to the approved plan markdown. */
  planPath: string;
  /** Override the in-session-vs-batch threshold (default 10). */
  threshold?: number;
}

export interface ImplementRoutingDecision {
  routing: ImplementRouting;
  taskCount: number;
  reason: string;
  plan: Plan;
}

/** Compute the routing decision from a parsed plan and threshold. Pure function. */
export function decideImplementRouting(input: { plan: Plan; threshold: number }): ImplementRoutingDecision {
  const taskCount = input.plan.tasks.length;
  const routing: ImplementRouting = taskCount <= input.threshold ? "in-session" : "batch";
  const reason =
    routing === "in-session"
      ? `${taskCount} task(s) ≤ threshold ${input.threshold}; running via steer in-session`
      : `${taskCount} task(s) > threshold ${input.threshold}; handing off to /supi:ultraplan batch worker`;
  return { routing, taskCount, reason, plan: input.plan };
}

/**
 * Verify pre-conditions before claiming Implement is safe to start. Returns error
 * messages (empty when ready). Used by the stage runner and the GC fixers.
 */
export function preflightImplement(input: { cwd: string; planPath: string; allowDirtyTree?: boolean }): string[] {
  const errors: string[] = [];
  if (!fs.existsSync(input.planPath)) {
    errors.push(`plan not found at ${input.planPath}`);
  }
  // Pre-flight git cleanliness check is handled by the command handler; we record the
  // requirement here so callers don't forget. (We don't shell out to git inside the
  // pure-function preflight to keep it deterministic.)
  if (!input.allowDirtyTree) {
    errors.push("caller must verify the working tree is clean before Implement (or pass allowDirtyTree)");
  }
  return errors;
}

export class HarnessImplementStage implements HarnessStageRunner {
  readonly stage = "implement" as const;

  constructor(private readonly input: ImplementStageInput) {}

  async isReady(_ctx: HarnessStageRunnerContext): Promise<boolean> {
    return fs.existsSync(this.input.planPath);
  }

  async isComplete(ctx: HarnessStageRunnerContext): Promise<boolean> {
    // Implement is complete when the post-implement self-check has been recorded in
    // implement-log.jsonl with `kind: "self-check-passed"`. The command handler appends
    // that record after running typecheck/test/scan.
    const logPath = path.join(
      path.dirname(this.input.planPath),
      "..",
      "harness",
      "sessions",
      ctx.sessionId,
      "implement-log.jsonl",
    );
    void logPath; // tracked but the stage runner does not introspect it directly.
    return false;
  }

  async run(ctx: HarnessStageRunnerContext): Promise<HarnessStageRunResult> {
    const errors = preflightImplement({
      cwd: ctx.cwd,
      planPath: this.input.planPath,
      allowDirtyTree: ctx.gateMode === "auto",
    });
    if (errors.length > 0) {
      return {
        status: "blocked",
        stage: this.stage,
        artifactPaths: [],
        blocker: { code: "implement-preflight-failed", message: errors.join("; ") },
      };
    }
    let raw: string;
    try {
      raw = fs.readFileSync(this.input.planPath, "utf8");
    } catch (error) {
      return {
        status: "failed",
        stage: this.stage,
        artifactPaths: [],
        error: `unable to read plan: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    let plan: Plan;
    try {
      plan = parsePlan(raw, this.input.planPath);
    } catch (error) {
      return {
        status: "failed",
        stage: this.stage,
        artifactPaths: [],
        error: `unable to parse plan: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const decision = decideImplementRouting({
      plan,
      threshold: this.input.threshold ?? DEFAULT_IN_SESSION_THRESHOLD,
    });

    appendImplementLog(ctx.paths, ctx.cwd, ctx.sessionId, {
      recordedAt: nowIso(ctx),
      kind: "routing-decision",
      routing: decision.routing,
      taskCount: decision.taskCount,
      reason: decision.reason,
      planPath: this.input.planPath,
    });

    return {
      status: "awaiting-user",
      stage: this.stage,
      artifactPaths: ["implement-log.jsonl"],
      details: {
        routing: decision.routing,
        taskCount: decision.taskCount,
        reason: decision.reason,
      },
    };
  }
}
