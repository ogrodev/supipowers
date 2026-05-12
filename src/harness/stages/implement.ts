/**
 * IMPLEMENT stage runner.
 *
 * Programmatic apply of every Tier 1 artifact defined by the design spec. Mirrors the
 * `/supi:checks` pattern: the stage runs deterministically inside the harness command,
 * with no handoff to the user's active agent. After this stage completes, the pipeline
 * naturally continues to docs (per-layer subagent dispatch) and validate (mechanical
 * checks) inside the same `/supi:harness` invocation.
 *
 * `decideImplementRouting` is retained as an exported helper for tests + future tooling;
 * the in-session-vs-batch heuristic is no longer used by the stage runner itself because
 * the apply path no longer needs the active agent.
 */

import * as fs from "node:fs";

import type { Plan } from "../../types.js";
import {
  type HarnessStageRunResult,
  type HarnessStageRunner,
  type HarnessStageRunnerContext,
  nowIso,
} from "../stage-runner.js";
import {
  appendImplementLog,
  hasSuccessfulImplementApply,
  loadHarnessDesignSpecJson,
} from "../storage.js";
import { applyHarnessPlan } from "./implement-apply.js";

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

  /**
   * Implement is driven by the programmatic apply, so `isComplete` returns true once a
   * successful apply has been recorded in `implement-log.jsonl`. This keeps reruns
   * idempotent without re-walking every applier (the appliers themselves are also
   * idempotent — this is a fast-skip for the common case). A subsequent failed apply in
   * the same session resets the result via the scan-from-end logic in storage.
   */
  async isComplete(ctx: HarnessStageRunnerContext): Promise<boolean> {
    return hasSuccessfulImplementApply(ctx.paths, ctx.cwd, ctx.sessionId);
  }

  async run(ctx: HarnessStageRunnerContext): Promise<HarnessStageRunResult> {
    const errors = preflightImplement({
      cwd: ctx.cwd,
      planPath: this.input.planPath,
      allowDirtyTree: ctx.gateMode !== "manual",
    });
    if (errors.length > 0) {
      return {
        status: "blocked",
        stage: this.stage,
        artifactPaths: [],
        blocker: { code: "implement-preflight-failed", message: errors.join("; ") },
      };
    }
    const designResult = loadHarnessDesignSpecJson(ctx.paths, ctx.cwd, ctx.sessionId);
    if (!designResult.ok) {
      return {
        status: "blocked",
        stage: this.stage,
        artifactPaths: [],
        blocker: {
          code: "design-spec-missing",
          message: "implement stage requires <session>/design-spec.json. Run /supi:harness design first.",
        },
      };
    }

    const recordedAt = nowIso(ctx);
    const outcome = await applyHarnessPlan({
      platform: ctx.platform,
      paths: ctx.paths,
      cwd: ctx.cwd,
      spec: designResult.value,
      apply: true,
    });

    appendImplementLog(ctx.paths, ctx.cwd, ctx.sessionId, {
      recordedAt,
      kind: "applied",
      planPath: this.input.planPath,
      applied: outcome.applied,
      warnings: outcome.warnings,
      errors: outcome.errors,
    });

    const artifactPaths = outcome.applied
      .filter((entry) => entry.action === "wrote" || entry.action === "patched")
      .map((entry) => entry.path);

    if (outcome.errors.length > 0) {
      const summary = outcome.errors
        .map((err) => `${err.step}: ${err.message}`)
        .join("; ");
      return {
        status: "blocked",
        stage: this.stage,
        artifactPaths,
        blocker: { code: "implement-apply-failed", message: summary },
        details: {
          applied: outcome.applied.length,
          errors: outcome.errors.length,
          warnings: outcome.warnings.length,
        },
      };
    }

    return {
      status: "completed",
      stage: this.stage,
      artifactPaths,
      details: {
        applied: outcome.applied.length,
        warnings: outcome.warnings.length,
        wrote: artifactPaths.length,
      },
    };
  }
}
