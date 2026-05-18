/**
 * Stage runner abstraction for the harness pipeline.
 *
 * Mirrors `src/ultraplan/authoring/stage-runner.ts` shape so future tooling that introspects
 * stage state (status renderers, debug loggers) can apply the same patterns to both pipelines
 * without case analysis. We do NOT subclass the ultraplan stage runner — both implement the
 * same abstract `StageRunner` shape independently because the artifact paths and stage
 * identifiers are different.
 *
 * Each stage:
 *  - resolves the model + agent prompt for the stage,
 *  - builds the assignment prompt deterministically from prior artifacts on disk,
 *  - spawns a fresh `platform.createAgentSession` and awaits its completion,
 *  - validates the produced artifact (TypeBox / shape check),
 *  - transitions the session manifest atomically.
 *
 * Stage runners are idempotent: if `isComplete` returns true, `run` returns
 * `status: "skipped"` without spawning an agent.
 */

import type { Platform, PlatformPaths } from "../platform/types.js";
import type {
  HarnessGateMode,
  HarnessPipelineProgressEvent,
  HarnessStage,
  HarnessStageStatus,
  ModelConfig,
} from "../types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface HarnessStageRunnerContext {
  platform: Platform;
  paths: PlatformPaths;
  cwd: string;
  sessionId: string;
  /** Loaded once at the start of the pipeline; passed in for model resolution. */
  modelConfig: ModelConfig;
  /** Gate mode currently in effect; stages may use it to short-circuit user prompts. */
  gateMode: HarnessGateMode;
  /**
   * Optional override for `now()` so tests can produce deterministic timestamps. Production
   * code defaults to `() => new Date().toISOString()`.
   */
  now?: () => string;
  /** Optional override for the agent session model. Tests use this to bypass resolution. */
  modelOverride?: { model: string; thinkingLevel: string | null };
  /** Live progress sink for long-running stage internals such as subagent turns. */
  onProgress?: (event: HarnessPipelineProgressEvent) => void;
}

export type HarnessStageRunStatus =
  | "completed" // Stage ran to completion and persisted its artifact.
  | "skipped" // Pre-conditions said the stage was already done.
  | "blocked" // Structured blocker (e.g. validation failure with no recovery).
  | "awaiting-user" // Stage produced output but needs a user gate before advancing.
  | "failed"; // Programming-level failure surfaced for the operator.

export interface HarnessStageRunResult {
  status: HarnessStageRunStatus;
  stage: HarnessStage;
  /** Artifact paths touched (relative to <session>/). */
  artifactPaths: string[];
  blocker?: { code: string; message: string };
  error?: string;
  details?: Record<string, unknown>;
}

export interface HarnessStageRunner {
  readonly stage: HarnessStage;
  isReady(ctx: HarnessStageRunnerContext): Promise<boolean>;
  isComplete(ctx: HarnessStageRunnerContext): Promise<boolean>;
  run(ctx: HarnessStageRunnerContext): Promise<HarnessStageRunResult>;
}

// ---------------------------------------------------------------------------
// Convenience helpers
// ---------------------------------------------------------------------------

export function nowIso(ctx: HarnessStageRunnerContext): string {
  return (ctx.now ?? (() => new Date().toISOString()))();
}

export function buildHarnessAgentDisplayName(stage: HarnessStage, discriminator?: string): string {
  return discriminator ? `harness-${stage}/${discriminator}` : `harness-${stage}`;
}

export function toHarnessStageStatus(status: HarnessStageRunStatus): HarnessStageStatus {
  switch (status) {
    case "completed":
    case "skipped":
      return "done";
    case "blocked":
    case "failed":
      return "blocked";
    case "awaiting-user":
      return "awaiting-user";
  }
}

/** Generate a deterministic session id: `harness-<base36 ms>-<6-hex random>`. */
export function newHarnessSessionId(now: () => Date = () => new Date()): string {
  const ms = now().getTime();
  const rand = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, "0");
  return `harness-${ms.toString(36)}-${rand}`;
}
