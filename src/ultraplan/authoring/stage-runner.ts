/**
 * Stage runner abstraction for the multi-stage authoring pipeline.
 *
 * Every stage runs as a fresh `platform.createAgentSession`. The stage runner is the thin
 * wrapper that:
 *  - resolves the model + agent prompt for the stage,
 *  - builds the assignment prompt deterministically from prior artifacts,
 *  - spawns the session and awaits its completion (the agent calls one or more
 *    `ultraplan_*` tools, which the hook bridge translates into atomic disk writes),
 *  - transitions the manifest's `authoring` block on success.
 *
 * This file owns the abstract interface only. Concrete stages live under `stages/`.
 *
 * Design notes:
 *  - Stages do not share state in memory. The disk artifacts under `<session>/authoring/`
 *    are the source of truth. `resume` is just `run` with the same inputs — which means
 *    we always re-derive prompts from disk, never from in-memory variables.
 *  - Each stage owns its own pre-flight check (`isReady`) and post-condition
 *    (`isComplete`). The pipeline driver uses these to decide whether to skip, run,
 *    or block.
 *  - Errors propagate as `StageRunResult` discriminated unions. Stage runners never throw
 *    on user-visible failures (validation, missing prerequisites, agent abort). They throw
 *    only on programming errors (malformed config, etc.).
 */

import type { Platform } from "../../platform/types.js";
import type { PlatformPaths } from "../../platform/types.js";
import type {
  ModelConfig,
  UltraPlanAuthoringStage,
  UltraPlanAuthoringStageStatus,
  UltraPlanBlocker,
} from "../../types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Inputs available to every stage runner. The runner reads from disk inside `run` rather
 * than capturing state at construction time, which keeps `resume` semantics trivial.
 */
export interface StageRunnerContext {
  platform: Platform;
  paths: PlatformPaths;
  cwd: string;
  sessionId: string;
  /** Loaded once at the start of the pipeline; passed in for model resolution. */
  modelConfig: ModelConfig;
  /**
   * Optional override for `now()` so tests can produce deterministic timestamps. Production
   * code defaults to `Date.now()` via `() => new Date().toISOString()`.
   */
  now?: () => string;
  /** Optional override for the agent session model. Tests use this to bypass resolution. */
  modelOverride?: { model: string; thinkingLevel: string | null };
}

export type StageRunStatus =
  | "completed"     // The stage ran to completion and persisted its artifact.
  | "skipped"       // Pre-conditions said the stage was already done; no work performed.
  | "blocked"       // The stage hit a structured blocker; manifest's `authoring.blocker` set.
  | "awaiting-user" // The stage produced output but needs a user gate before advancing.
  | "failed";       // Programming-level failure; surfaced for the operator with `error`.

export interface StageRunResult {
  status: StageRunStatus;
  stage: UltraPlanAuthoringStage;
  /** Artifacts touched by this run (relative to `<session>/authoring/`). */
  artifactPaths: string[];
  /** Set when status is `blocked`. */
  blocker?: UltraPlanBlocker;
  /** Set when status is `failed`. */
  error?: string;
  /** Free-form structured details for `pipeline-log.jsonl`. */
  details?: Record<string, unknown>;
}

export interface StageRunner {
  /** The stage this runner advances. Constant per runner. */
  readonly stage: UltraPlanAuthoringStage;

  /**
   * Cheap existence check: are the upstream artifacts the stage needs available on disk?
   * The pipeline driver calls this before `run` to bucket sessions in the resume picker.
   */
  isReady(ctx: StageRunnerContext): Promise<boolean>;

  /**
   * Has this stage already been completed for the given session? Used by `resume` to
   * decide whether to re-run or skip. Returns `true` if the stage's primary artifact
   * exists on disk and passes its schema validation.
   */
  isComplete(ctx: StageRunnerContext): Promise<boolean>;

  /**
   * Execute the stage. Idempotent: if `isComplete` returns true, the runner returns
   * `status: "skipped"` without spawning an agent. Otherwise it runs the agent, awaits
   * completion, validates the produced artifact, and updates the manifest's
   * `authoring.stage` / `stageStatus` fields atomically.
   */
  run(ctx: StageRunnerContext): Promise<StageRunResult>;
}

// ---------------------------------------------------------------------------
// Convenience helpers shared by concrete stages
// ---------------------------------------------------------------------------

export function nowIso(ctx: StageRunnerContext): string {
  return (ctx.now ?? (() => new Date().toISOString()))();
}

/**
 * Build a deterministic agent display name for the spawned `createAgentSession`. The
 * convention `ultraplan-authoring-<stage>[/<discriminator>]` lets the picker and logs
 * correlate sessions to stages without parsing prompts.
 */
export function buildAgentDisplayName(
  stage: UltraPlanAuthoringStage,
  discriminator?: string,
): string {
  return discriminator ? `ultraplan-authoring-${stage}/${discriminator}` : `ultraplan-authoring-${stage}`;
}

/**
 * Translate a `StageRunStatus` to the manifest's `stageStatus` value for the same stage.
 */
export function toManifestStageStatus(status: StageRunStatus): UltraPlanAuthoringStageStatus {
  switch (status) {
    case "completed":
      return "done";
    case "skipped":
      return "done";
    case "blocked":
      return "blocked";
    case "awaiting-user":
      return "awaiting-user";
    case "failed":
      return "blocked";
  }
}
