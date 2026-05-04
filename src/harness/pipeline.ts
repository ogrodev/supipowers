/**
 * Pipeline driver for the harness.
 *
 * Mirrors `src/ultraplan/authoring/pipeline.ts` but with harness's own stage list.
 * Drives the pipeline forward stage-by-stage until either:
 *  - the pipeline reaches Validate successfully (returns `promoted: true`),
 *  - it lands at a gate stage (returns `awaiting-user`),
 *  - or a stage returns `failed` / `blocked`.
 */

import type { Platform, PlatformPaths } from "../platform/types.js";
import type {
  HarnessGateMode,
  HarnessStage,
  ModelConfig,
} from "../types.js";
import {
  type HarnessStageRunResult,
  type HarnessStageRunner,
  type HarnessStageRunnerContext,
} from "./stage-runner.js";
import { HarnessDiscoverStage } from "./stages/discover.js";
import { HarnessResearchStage } from "./stages/research.js";
import { HarnessDesignStage, type DesignStageInput } from "./stages/design.js";
import { HarnessPlanStage } from "./stages/plan.js";
import { HarnessImplementStage, type ImplementStageInput } from "./stages/implement.js";
import { HarnessValidateStage, type ValidateStageInput } from "./stages/validate.js";

const STAGE_ORDER: readonly HarnessStage[] = [
  "discover",
  "research",
  "design",
  "plan",
  "implement",
  "validate",
];

/** Default gate set per mode. */
const GATE_STAGES_DEFAULT: ReadonlySet<HarnessStage> = new Set([
  "discover",
  "design",
  "plan",
  "validate",
]);
const GATE_STAGES_MANUAL: ReadonlySet<HarnessStage> = new Set([
  "discover",
  "research",
  "design",
  "plan",
  "implement",
  "validate",
]);

function gateStagesFor(mode: HarnessGateMode): ReadonlySet<HarnessStage> {
  switch (mode) {
    case "default":
      return GATE_STAGES_DEFAULT;
    case "auto":
      return new Set();
    case "manual":
      return GATE_STAGES_MANUAL;
  }
}

export interface BuildRunnerInput {
  /** Required when running the design stage. */
  designInput?: DesignStageInput;
  /** Required when running the implement stage. */
  implementInput?: ImplementStageInput;
  /** Required when running the validate stage. */
  validateInput?: ValidateStageInput;
}

export function buildHarnessRunner(stage: HarnessStage, input: BuildRunnerInput): HarnessStageRunner {
  switch (stage) {
    case "discover":
      return new HarnessDiscoverStage();
    case "research":
      return new HarnessResearchStage();
    case "design":
      if (!input.designInput) {
        throw new Error("buildHarnessRunner: design stage requires designInput");
      }
      return new HarnessDesignStage(input.designInput);
    case "plan":
      return new HarnessPlanStage();
    case "implement":
      if (!input.implementInput) {
        throw new Error("buildHarnessRunner: implement stage requires implementInput");
      }
      return new HarnessImplementStage(input.implementInput);
    case "validate":
      if (!input.validateInput) {
        throw new Error("buildHarnessRunner: validate stage requires validateInput");
      }
      return new HarnessValidateStage(input.validateInput);
  }
}

export interface PipelineRunOutcome {
  stage: HarnessStage;
  status: HarnessStageRunResult["status"];
  /** True when the pipeline reached Validate with a passing report. */
  promoted: boolean;
  message?: string;
  /** Trace of every stage visited this run. */
  trace: { stage: HarnessStage; status: HarnessStageRunResult["status"] }[];
}

export interface PipelineDriverInput {
  platform: Platform;
  paths: PlatformPaths;
  cwd: string;
  sessionId: string;
  modelConfig: ModelConfig;
  gates: HarnessGateMode;
  /** Stage-specific inputs supplied by the command handler. */
  stageInputs: BuildRunnerInput;
  /**
   * When set, start the pipeline at this stage (skipping earlier stages even when not
   * complete). Used by per-stage subcommands.
   */
  startStage?: HarnessStage;
  /** Hard cap on stage iterations — defends against runners that report `completed`
   *  without advancing on disk. */
  safetyLimit?: number;
}

/**
 * Run the pipeline forward until completion or a gate. Each stage:
 *  - is skipped when its `isComplete` returns true;
 *  - blocks/fails surface immediately;
 *  - awaiting-user returns to the caller with the gate decision.
 */
export async function runHarnessPipelineUntilGate(
  input: PipelineDriverInput,
): Promise<PipelineRunOutcome> {
  const trace: { stage: HarnessStage; status: HarnessStageRunResult["status"] }[] = [];
  const gateStages = gateStagesFor(input.gates);
  const safetyLimit = input.safetyLimit ?? 12;
  let safety = 0;

  let stageIndex = input.startStage ? STAGE_ORDER.indexOf(input.startStage) : 0;
  if (stageIndex < 0) stageIndex = 0;

  while (safety < safetyLimit) {
    safety += 1;
    if (stageIndex >= STAGE_ORDER.length) break;
    const stage = STAGE_ORDER[stageIndex];

    const runner = buildHarnessRunner(stage, input.stageInputs);
    const ctx: HarnessStageRunnerContext = {
      platform: input.platform,
      paths: input.paths,
      cwd: input.cwd,
      sessionId: input.sessionId,
      modelConfig: input.modelConfig,
      gateMode: input.gates,
    };

    const result = await runner.run(ctx);
    trace.push({ stage, status: result.status });

    if (result.status === "failed" || result.status === "blocked") {
      return {
        stage,
        status: result.status,
        promoted: false,
        message: result.error ?? result.blocker?.message,
        trace,
      };
    }

    if (gateStages.has(stage) && result.status !== "skipped") {
      return {
        stage,
        status: "awaiting-user",
        promoted: false,
        trace,
      };
    }

    if (stage === "validate" && (result.status === "completed" || result.status === "skipped" || result.status === "awaiting-user")) {
      return {
        stage: "validate",
        status: result.status,
        promoted: true,
        trace,
      };
    }

    stageIndex += 1;
  }

  return {
    stage: "validate",
    status: "failed",
    promoted: false,
    message: "harness pipeline exceeded its safety cap",
    trace,
  };
}

export const HARNESS_STAGE_ORDER = STAGE_ORDER;
