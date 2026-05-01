/**
 * Pipeline driver for the multi-stage authoring flow.
 *
 * Resolves the next stage to run from the manifest's `authoring` block, executes it via the
 * stage's runner, and either advances or surfaces a gate decision to the caller. The driver
 * is intentionally pure orchestration \u2014 every disk write goes through `authoring/storage`.
 *
 * Three gate modes:
 *  - `default`: gates at discover, synthesize, approve.
 *  - `auto`:    no user gates; runs end-to-end. Synthesize still produces a draft and the
 *               approve stage promotes it without a user confirmation.
 *  - `manual`:  every stage waits for explicit advance commands.
 */

import * as fs from "node:fs";

import type { Platform, PlatformPaths } from "../../platform/types.js";
import type {
  ModelConfig,
  UltraPlanAuthoringStage,
} from "../../types.js";

import { ApproveStage } from "./stages/approve.js";
import { DiscoverStage } from "./stages/discover.js";
import { IntakeStage } from "./stages/intake.js";
import { ResearchStage } from "./stages/research.js";
import { ReviewStage } from "./stages/review.js";
import { ScoutStage } from "./stages/scout.js";
import { SynthesizeStage } from "./stages/synthesize.js";
import {
  loadAuthoringState,
} from "./storage.js";
import type {
  StageRunResult,
  StageRunner,
  StageRunnerContext,
} from "./stage-runner.js";
import { runSynthGateLoop } from "./synth-gate.js";
import {
  getUltraplanAuthoringDecisionsPath,
  getUltraplanAuthoringDir,
  getUltraplanAuthoringIntakePath,
  getUltraplanAuthoringResearchSummaryPath,
  getUltraplanAuthoringScoutPath,
} from "../project-paths.js";

export type PipelineGateMode = "default" | "auto" | "manual";

const GATE_STAGES_DEFAULT = new Set<UltraPlanAuthoringStage>(["discover", "synthesize", "approve"]);
const GATE_STAGES_MANUAL = new Set<UltraPlanAuthoringStage>([
  "intake",
  "scout",
  "discover",
  "research",
  "synthesize",
  "review",
  "approve",
]);

export interface PipelineDriverInput {
  platform: Platform;
  paths: PlatformPaths;
  cwd: string;
  sessionId: string;
  modelConfig: ModelConfig;
  /** Required for INTAKE stage; ignored once intake artifact exists. */
  seedPrompt: string;
  gates: PipelineGateMode;
  /** Iteration to use for review/approve. Defaults to 1. */
  iteration?: number;
}

export interface PipelineRunOutcome {
  /** Final stage that was executed (or attempted). */
  stage: UltraPlanAuthoringStage;
  status: StageRunResult["status"];
  /** True when the pipeline reached APPROVE successfully. */
  promoted: boolean;
  /** Error or blocker message, when status is failed/blocked. */
  message?: string;
  /** Human-readable summary of every stage that ran. */
  trace: { stage: UltraPlanAuthoringStage; status: StageRunResult["status"] }[];
}

interface ResolvedNextStage {
  stage: UltraPlanAuthoringStage;
  reason: "fresh-start" | "next-after-completed" | "resume-incomplete";
}

/**
 * Find the stage that should run next for a session. Reads the manifest's `authoring` block;
 * falls back to disk artifact existence for sessions that were started by a different driver
 * version that didn't persist the manifest block.
 */
export function resolveNextStage(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
): ResolvedNextStage {
  const stateResult = loadAuthoringState(paths, cwd, sessionId);
  if (stateResult.ok && stateResult.value) {
    const state = stateResult.value;
    if (state.stageStatus === "running") {
      return { stage: state.stage, reason: "resume-incomplete" };
    }
    if (state.stageStatus === "blocked" || state.stageStatus === "awaiting-user") {
      return { stage: state.stage, reason: "resume-incomplete" };
    }
    // status === "done" \u2014 advance to the next stage.
    const next = nextStageOf(state.stage);
    if (next) return { stage: next, reason: "next-after-completed" };
    return { stage: "approve", reason: "next-after-completed" };
  }

  // Fall back to disk artifact existence.
  if (!fs.existsSync(getUltraplanAuthoringIntakePath(paths, cwd, sessionId))) {
    return { stage: "intake", reason: "fresh-start" };
  }
  if (!fs.existsSync(getUltraplanAuthoringScoutPath(paths, cwd, sessionId))) {
    return { stage: "scout", reason: "resume-incomplete" };
  }
  if (!fs.existsSync(getUltraplanAuthoringDecisionsPath(paths, cwd, sessionId))) {
    return { stage: "discover", reason: "resume-incomplete" };
  }
  if (!fs.existsSync(getUltraplanAuthoringResearchSummaryPath(paths, cwd, sessionId))) {
    return { stage: "research", reason: "resume-incomplete" };
  }
  return { stage: "synthesize", reason: "resume-incomplete" };
}

function nextStageOf(stage: UltraPlanAuthoringStage): UltraPlanAuthoringStage | null {
  switch (stage) {
    case "intake":
      return "scout";
    case "scout":
      return "discover";
    case "discover":
      return "research";
    case "research":
      return "synthesize";
    case "synthesize":
      return "review";
    case "review":
      return "approve";
    case "approve":
      return null;
  }
}

/**
 * Run a single stage by name. Used both by the full driver and by the per-stage CLI
 * subcommands (`/supi:ultraplan discover`, `/supi:ultraplan research`, etc).
 */
export async function runStage(
  stage: UltraPlanAuthoringStage,
  input: Omit<PipelineDriverInput, "gates">,
): Promise<StageRunResult> {
  const ctx: StageRunnerContext = {
    platform: input.platform,
    paths: input.paths,
    cwd: input.cwd,
    sessionId: input.sessionId,
    modelConfig: input.modelConfig,
  };
  const runner = buildRunner(stage, input);
  return runner.run(ctx);
}

function buildRunner(
  stage: UltraPlanAuthoringStage,
  input: Omit<PipelineDriverInput, "gates">,
): StageRunner {
  switch (stage) {
    case "intake":
      return new IntakeStage({ seedPrompt: input.seedPrompt });
    case "scout":
      return new ScoutStage();
    case "discover":
      return new DiscoverStage();
    case "research":
      return new ResearchStage();
    case "synthesize":
      return new SynthesizeStage();
    case "review":
      return new ReviewStage({ iteration: input.iteration ?? 1 });
    case "approve":
      return new ApproveStage({ iteration: input.iteration ?? 1 });
  }
}

function gateStagesFor(mode: PipelineGateMode): Set<UltraPlanAuthoringStage> {
  switch (mode) {
    case "default":
      return GATE_STAGES_DEFAULT;
    case "auto":
      return new Set();
    case "manual":
      return GATE_STAGES_MANUAL;
  }
}

/**
 * Run the pipeline forward until either (a) it completes through APPROVE, (b) it lands at a
 * gate stage, or (c) a stage returns `failed`/`blocked`. Synth-stage gating includes the
 * `$EDITOR` round-trip via `runSynthGateLoop`.
 *
 * The driver does **not** run interactive UI prompts on its own \u2014 the calling command
 * orchestrator wraps the call and presents `ctx.ui.select` / `ctx.ui.confirm` between
 * driver invocations.
 */
export async function runPipelineUntilGate(input: PipelineDriverInput): Promise<PipelineRunOutcome> {
  const trace: { stage: UltraPlanAuthoringStage; status: StageRunResult["status"] }[] = [];
  const gateStages = gateStagesFor(input.gates);

  let safety = 0;
  // Hard cap to prevent runaway loops if a runner ever returns `completed` without advancing
  // its on-disk state. We've sized this to handle the longest legitimate path (intake \u2192 scout
  // \u2192 discover \u2192 research \u2192 synthesize \u2192 review \u2192 approve = 7) plus a margin.
  while (safety < 16) {
    safety += 1;
    const next = resolveNextStage(input.paths, input.cwd, input.sessionId);
    const runner = buildRunner(next.stage, input);
    const ctx: StageRunnerContext = {
      platform: input.platform,
      paths: input.paths,
      cwd: input.cwd,
      sessionId: input.sessionId,
      modelConfig: input.modelConfig,
    };

    const result = await runner.run(ctx);
    trace.push({ stage: next.stage, status: result.status });

    if (result.status === "failed" || result.status === "blocked") {
      return {
        stage: next.stage,
        status: result.status,
        promoted: false,
        message: result.error ?? result.blocker?.message,
        trace,
      };
    }

    // Synth-stage editor round-trip when in non-manual modes. After the planner draft is
    // persisted, run the editor gate; on save, the driver continues to review.
    if (next.stage === "synthesize" && result.status === "awaiting-user" && input.gates !== "manual") {
      const gate = await runSynthGateLoop({
        platform: input.platform,
        paths: input.paths,
        cwd: input.cwd,
        sessionId: input.sessionId,
        iteration: input.iteration ?? 1,
      });
      if (gate.status === "io-error" || gate.status === "parse-failed") {
        return {
          stage: next.stage,
          status: "blocked",
          promoted: false,
          message: gate.status === "parse-failed"
            ? `Synth gate parse-failed after retries: ${gate.errors.map((e) => e.message).join("; ")}`
            : gate.message,
          trace,
        };
      }
    }

    if (gateStages.has(next.stage) && result.status !== "skipped") {
      // Awaiting user gate: caller orchestrates the prompt and re-invokes the driver.
      return {
        stage: next.stage,
        status: "awaiting-user",
        promoted: false,
        trace,
      };
    }

    if (next.stage === "approve" && (result.status === "completed" || result.status === "skipped")) {
      return {
        stage: "approve",
        status: result.status,
        promoted: true,
        trace,
      };
    }
  }

  return {
    stage: "approve",
    status: "failed",
    promoted: false,
    message: "Pipeline driver exceeded its safety cap; check the manifest's authoring block for inconsistency.",
    trace,
  };
}

/**
 * Detect every in-flight authoring session for the picker. Returns sessions whose manifest
 * has an `authoring` block AND whose canonical authored.json doesn't exist yet (i.e. they
 * haven't been promoted).
 */
export function listInFlightAuthoringSessions(
  paths: PlatformPaths,
  cwd: string,
  sessionIds: string[],
): { sessionId: string; stage: UltraPlanAuthoringStage; status: string }[] {
  const inFlight = [];
  for (const sessionId of sessionIds) {
    const dir = getUltraplanAuthoringDir(paths, cwd, sessionId);
    if (!fs.existsSync(dir)) continue;
    const stateResult = loadAuthoringState(paths, cwd, sessionId);
    if (!stateResult.ok || !stateResult.value) continue;
    inFlight.push({
      sessionId,
      stage: stateResult.value.stage,
      status: stateResult.value.stageStatus,
    });
  }
  return inFlight;
}
