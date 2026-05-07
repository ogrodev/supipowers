/**
 * Pipeline driver for the harness.
 *
 * Mirrors `src/ultraplan/authoring/pipeline.ts` but with harness's own stage list.
 * Drives the pipeline forward stage-by-stage until either:
 *  - the pipeline reaches Validate successfully (returns `promoted: true`),
 *  - it lands at a gate stage (returns `awaiting-user`),
 *  - or a stage returns `failed` / `blocked`.
 */

import * as fs from "node:fs";
import * as path from "node:path";

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
import {
  HarnessDesignStage,
  type DesignStageInput,
  defaultDesignSpecFromDiscover,
} from "./stages/design.js";
import { HarnessPlanStage, type PlanStageInput } from "./stages/plan.js";
import { HarnessImplementStage, type ImplementStageInput } from "./stages/implement.js";
import { HarnessValidateStage, type ValidateStageInput } from "./stages/validate.js";
import { loadHarnessDesignSpecJson, loadHarnessDiscover } from "./storage.js";
import { buildBackendAdapter } from "./anti_slop/backend-factory.js";
import { DEFAULT_HARNESS_CONFIG } from "./hooks/register.js";
import { getProjectStatePath } from "../workspace/state-paths.js";

/** Progress event emitted by the pipeline driver for UI feedback. */
export type HarnessPipelineProgressEvent =
  | { type: "stage-started"; stage: HarnessStage }
  | { type: "stage-skipped"; stage: HarnessStage }
  | { type: "stage-completed"; stage: HarnessStage; detail?: string }
  | { type: "stage-blocked"; stage: HarnessStage; detail: string }
  | { type: "stage-failed"; stage: HarnessStage; detail: string }
  | { type: "awaiting-user"; stage: HarnessStage; detail?: string };

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
  /** Optional override for the plan stage (filename only). */
  planInput?: PlanStageInput;
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
      return new HarnessPlanStage(input.planInput);
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
  /** Hard cap on stage iterations. */
  safetyLimit?: number;
  /** Optional callback for progress events (wire up a progress widget). */
  onProgress?: (event: HarnessPipelineProgressEvent) => void;
}

// ── Stage input derivation ──────────────────────────────────────────

function ensureStageInputs(
  input: PipelineDriverInput,
  stage: HarnessStage,
): BuildRunnerInput {
  const base = input.stageInputs;

  switch (stage) {
    case "design": {
      if (base.designInput) return base;
      const discover = loadHarnessDiscover(input.paths, input.cwd, input.sessionId);
      if (!discover.ok) return base;
      const spec = defaultDesignSpecFromDiscover(
        discover.value,
        input.sessionId,
        new Date().toISOString(),
      );
      return { ...base, designInput: { spec } };
    }
    case "implement": {
      if (base.implementInput) return base;
      const planName = `harness-${input.sessionId}.md`;
      const plansDir = getProjectStatePath(input.paths, input.cwd, "plans");
      const planPath = path.join(plansDir, planName);
      if (!fs.existsSync(planPath)) return base;
      const threshold = DEFAULT_HARNESS_CONFIG.implement_in_session_threshold ?? 10;
      return { ...base, implementInput: { planPath, threshold } };
    }
    case "validate": {
      if (base.validateInput) return base;
      const designResult = loadHarnessDesignSpecJson(
        input.paths,
        input.cwd,
        input.sessionId,
      );
      if (!designResult.ok) return base;
      const spec = designResult.value;
      const adapter = buildBackendAdapter(spec.antiSlop.backend);
      return {
        ...base,
        validateInput: {
          backend: spec.antiSlop.backend,
          adapter: adapter ?? undefined,
          scoreFloor: spec.antiSlop.hooks.score_floor,
          hooks: spec.antiSlop.hooks,
        },
      };
    }
    default:
      return base;
  }
}

function formatStageDetail(result: HarnessStageRunResult): string {
  const d = result.details;
  if (!d) return result.status;
  if (result.stage === "discover" && Array.isArray(d.languages)) {
    const langs = (d.languages as string[]).slice(0, 3).join(", ");
    return `${langs}${d.languages.length > 3 ? ", …" : ""} · ${d.recommendedBackend ?? "?"}`;
  }
  if (result.stage === "design") {
    const backend = d.backend ?? "?";
    const layers = typeof d.layerCount === "number" ? `${d.layerCount} layers` : "";
    return layers ? `${backend} · ${layers}` : `${backend}`;
  }
  if (result.stage === "validate" && typeof d.passed === "boolean") {
    return d.passed ? "passed" : "issues found";
  }
  return result.status;
}

function awaitUserDetail(result: HarnessStageRunResult): string {
  return formatStageDetail(result) || "awaiting review";
}
// ── Pipeline loop ───────────────────────────────────────────────────
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

    input.onProgress?.({ type: "stage-started", stage });

    const stageInputs = ensureStageInputs(input, stage);
    const runner = buildHarnessRunner(stage, stageInputs);

    const isComplete = await runner.isComplete({
      platform: input.platform,
      paths: input.paths,
      cwd: input.cwd,
      sessionId: input.sessionId,
      modelConfig: input.modelConfig,
      gateMode: input.gates,
    });

    if (isComplete) {
      input.onProgress?.({ type: "stage-skipped", stage });
      trace.push({ stage, status: "skipped" });
      stageIndex += 1;
      continue;
    }

    const ctx: HarnessStageRunnerContext = {
      platform: input.platform,
      paths: input.paths,
      cwd: input.cwd,
      sessionId: input.sessionId,
      modelConfig: input.modelConfig,
      gateMode: input.gates,
    };

    const result = await runner.run(ctx);

    // In auto mode, awaiting-user is equivalent to completed — normalize
    // both the trace entry and any outcome derived from it so the UI never
    // shows a confusing mix of checkmarks and "awaiting user".
    const isGate = gateStages.has(stage);
    const normalizedStatus: HarnessStageRunResult["status"] =
      result.status === "awaiting-user" && !isGate
        ? "completed"
        : result.status;
    trace.push({ stage, status: normalizedStatus });

    const detail = formatStageDetail(result);

    if (result.status === "failed") {
      input.onProgress?.({ type: "stage-failed", stage, detail: result.error ?? detail });
      return {
        stage, status: result.status, promoted: false,
        message: result.error, trace,
      };
    }

    if (result.status === "blocked") {
      input.onProgress?.({ type: "stage-blocked", stage, detail: result.blocker?.message ?? detail });
      return {
        stage, status: result.status, promoted: false,
        message: result.blocker?.message, trace,
      };
    }

    // In auto mode, awaiting-user is equivalent to completed — the pipeline
    // continues without stopping. Only surface the distinction when gated.
    if (normalizedStatus === "awaiting-user" && isGate) {
      input.onProgress?.({ type: "awaiting-user", stage, detail: awaitUserDetail(result) });
    } else {
      input.onProgress?.({ type: "stage-completed", stage, detail });
    }

    if (isGate && normalizedStatus !== "skipped") {
      return {
        stage,
        status: "awaiting-user",
        promoted: false,
        trace,
      };
    }

    if (stage === "validate" && (normalizedStatus === "completed" || normalizedStatus === "skipped")) {
      return {
        stage: "validate",
        status: normalizedStatus,
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
