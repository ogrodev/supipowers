/**
 * REVIEW stage runner.
 *
 * Spawns three checker agents in parallel — `structure-checker`, `scope-checker`,
 * `tdd-checker` — against a synthesized draft. Each checker calls
 * `ultraplan_review_finding` zero or more times; the tool accumulates findings into
 * `drafts/iteration-N/findings.json`.
 *
 * If no checker calls the tool (zero findings — a valid converged state), the stage
 * runner writes an empty findings artifact so `isComplete` is satisfied.
 *
 * Resume semantics: skipped when findings.json exists and validates for the iteration.
 * Future iterations re-run the same stage against their own iteration directory.
 */

import * as fs from "node:fs";

import { resolveAuthoringSlot } from "../agent-catalog.js";
import { resolveAuthoringSlotModel } from "../model.js";
import { modelRegistry } from "../../../config/model-registry-instance.js";
import {
  appendPipelineLog,
  loadDraftAuthoredJson,
  loadFindingsArtifact,
  loadResearchSummary,
  saveAuthoringState,
  saveFindingsArtifact,
} from "../storage.js";
import {
  buildAgentDisplayName,
  nowIso,
  toManifestStageStatus,
  type StageRunResult,
  type StageRunner,
  type StageRunnerContext,
} from "../stage-runner.js";
import {
  getUltraplanAuthoringDecisionsPath,
  getUltraplanAuthoringDraftAuthoredJsonPath,
  getUltraplanAuthoringDraftFindingsPath,
} from "../../project-paths.js";
import type { UltraPlanAuthoringSlotName } from "../../../types.js";

// ---------------------------------------------------------------------------
// Checker slot constants
// ---------------------------------------------------------------------------

const CHECKER_SLOTS = ["structure-checker", "scope-checker", "tdd-checker"] as const satisfies readonly UltraPlanAuthoringSlotName[];
type CheckerSlot = (typeof CHECKER_SLOTS)[number];

const CHECKER_FOCUS: Record<CheckerSlot, string> = {
  "structure-checker":
    "Verify that the authored.json structure is internally consistent: domains reference valid stacks, scenario ids are unique and kebab-case, all required fields are present and non-empty, and the stacks/domains/scenarios hierarchy is coherent.",
  "scope-checker":
    "Verify that the scope is bounded: no single scenario conflates multiple jobs, every domain aligns with the stated goal, nothing from the deferred-ideas list has crept back in, and no gaps exist between the goal and the domain coverage.",
  "tdd-checker":
    "Verify that every scenario has testable acceptance criteria (unit, integration, or e2e as appropriate), that the described test patterns are consistent with the project's existing test conventions identified by scout, and that no scenario is only verifiable by manual inspection.",
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Inputs unique to REVIEW: which draft iteration to review (default 1). */
export interface ReviewStageInput {
  iteration?: number;
}

// ---------------------------------------------------------------------------
// Assignment builder
// ---------------------------------------------------------------------------

function buildCheckerAssignment(
  ctx: StageRunnerContext,
  slot: CheckerSlot,
  iteration: number,
  draft: unknown,
  researchSummary: string | null,
  decisions: string | null,
): string {
  const parts: string[] = [
    `# UltraPlan authoring · review (${slot})`,
    ``,
    `Session id: ${ctx.sessionId}`,
    `cwd: ${ctx.cwd}`,
    `Iteration: ${iteration}`,
    ``,
    `## Focus area`,
    ``,
    CHECKER_FOCUS[slot],
    ``,
    `## Draft authored.json (iteration ${iteration})`,
    "```json",
    JSON.stringify(draft, null, 2),
    "```",
    ``,
  ];

  if (researchSummary) {
    parts.push(
      `## Research summary`,
      "```",
      researchSummary,
      "```",
      ``,
    );
  }

  if (decisions) {
    parts.push(
      `## Discover decisions (decisions.jsonl — JSONL, one record per line)`,
      "```",
      decisions,
      "```",
      ``,
    );
  }

  parts.push(
    `## Your task`,
    ``,
    `Review the draft with your focus area above. Call \`ultraplan_review_finding\` for each issue you identify. You MAY call it zero times if the draft is clean in your area — zero findings is a valid and desirable outcome.`,
    ``,
    `Required fields for each call:`,
    `- sessionId: ${JSON.stringify(ctx.sessionId)}`,
    `- iteration: ${iteration}`,
    `- id: stable kebab-case id (unique across all findings)`,
    `- severity: BLOCKER | WARNING`,
    `- source: ${slot}`,
    `- target: { stack, domainId, scenarioId } — use null for fields that do not apply`,
    `- message: concise description of the issue`,
    `- recommendation: actionable fix suggestion`,
    ``,
    `Return after all calls. Do not append a chat summary.`,
  );

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Stage runner
// ---------------------------------------------------------------------------

export class ReviewStage implements StageRunner {
  readonly stage = "review" as const;

  private readonly iteration: number;

  constructor(input: ReviewStageInput = {}) {
    this.iteration = input.iteration ?? 1;
  }

  async isReady(ctx: StageRunnerContext): Promise<boolean> {
    return fs.existsSync(
      getUltraplanAuthoringDraftAuthoredJsonPath(ctx.paths, ctx.cwd, ctx.sessionId, this.iteration),
    );
  }

  async isComplete(ctx: StageRunnerContext): Promise<boolean> {
    const artifactPath = getUltraplanAuthoringDraftFindingsPath(
      ctx.paths,
      ctx.cwd,
      ctx.sessionId,
      this.iteration,
    );
    if (!fs.existsSync(artifactPath)) return false;
    const loaded = loadFindingsArtifact(ctx.paths, ctx.cwd, ctx.sessionId, this.iteration);
    return loaded.ok;
  }

  async run(ctx: StageRunnerContext): Promise<StageRunResult> {
    if (!(await this.isReady(ctx))) {
      return {
        status: "failed",
        stage: this.stage,
        artifactPaths: [],
        error: `REVIEW requires drafts/iteration-${this.iteration}/authored.json; run the synthesize stage first.`,
      };
    }

    if (await this.isComplete(ctx)) {
      return {
        status: "skipped",
        stage: this.stage,
        artifactPaths: [`authoring/drafts/iteration-${this.iteration}/findings.json`],
        details: { reason: `findings artifact already exists for iteration ${this.iteration}` },
      };
    }

    // Load the draft as context for all checkers.
    const draftResult = loadDraftAuthoredJson(ctx.paths, ctx.cwd, ctx.sessionId, this.iteration);
    if (!draftResult.ok) {
      return {
        status: "failed",
        stage: this.stage,
        artifactPaths: [],
        error: `REVIEW could not read draft authored.json: ${draftResult.error.message}`,
      };
    }

    // Load optional upstream artifacts for richer context; missing is non-fatal.
    const summaryResult = loadResearchSummary(ctx.paths, ctx.cwd, ctx.sessionId);
    const researchSummary = summaryResult.ok ? summaryResult.value : null;

    const decisionsPath = getUltraplanAuthoringDecisionsPath(ctx.paths, ctx.cwd, ctx.sessionId);
    const decisions = fs.existsSync(decisionsPath)
      ? fs.readFileSync(decisionsPath, "utf8")
      : null;

    // Mark the stage running before spawning agents so resume can find it mid-flight.
    saveAuthoringState(ctx.paths, ctx.cwd, ctx.sessionId, {
      pipeline: "multi-stage",
      stage: this.stage,
      stageStatus: "running",
      iteration: this.iteration,
      stallReentryCount: 0,
      artifacts: {},
      blocker: null,
      startedAt: nowIso(ctx),
      updatedAt: nowIso(ctx),
    });

    // Spawn all three checkers concurrently.
    await Promise.all(
      CHECKER_SLOTS.map(async (slot) => {
        const resolvedModel =
          ctx.modelOverride ??
          resolveAuthoringSlotModel(
            slot,
            null,
            ctx.modelConfig,
            modelRegistry,
            {
              getModelForRole: (role) => ctx.platform.getModelForRole?.(role) ?? null,
              getCurrentModel: () => ctx.platform.getCurrentModel?.() ?? "unknown",
            },
          );

        const slotBinding = resolveAuthoringSlot(slot, ctx.paths, ctx.cwd);

        const sessionOpts: Record<string, unknown> = {
          cwd: ctx.cwd,
          agentDisplayName: buildAgentDisplayName(this.stage, slot),
          agentId: `ultraplan-authoring-${this.stage}-${slot}-${ctx.sessionId}`,
        };
        if (resolvedModel.model) sessionOpts.model = resolvedModel.model;
        if (resolvedModel.thinkingLevel) sessionOpts.thinkingLevel = resolvedModel.thinkingLevel;

        const agentSession = await ctx.platform.createAgentSession(sessionOpts as never);
        const assignment = [
          slotBinding.definition.prompt.trim(),
          "",
          buildCheckerAssignment(
            ctx,
            slot,
            this.iteration,
            draftResult.value,
            researchSummary,
            decisions,
          ),
        ].join("\n");

        try {
          await agentSession.prompt(assignment, { expandPromptTemplates: false });
        } finally {
          await agentSession.dispose();
        }
      }),
    );

    // If no checker called ultraplan_review_finding, write an empty findings artifact
    // so isComplete is satisfied (zero findings is a valid converged state).
    const findingsPath = getUltraplanAuthoringDraftFindingsPath(
      ctx.paths,
      ctx.cwd,
      ctx.sessionId,
      this.iteration,
    );
    if (!fs.existsSync(findingsPath)) {
      const emptyArtifact = {
        iteration: this.iteration,
        draftRef: `drafts/iteration-${this.iteration}/authored.json`,
        recordedAt: nowIso(ctx),
        findings: [],
      };
      const saved = saveFindingsArtifact(
        ctx.paths,
        ctx.cwd,
        ctx.sessionId,
        this.iteration,
        emptyArtifact,
      );
      if (!saved.ok) {
        return {
          status: "failed",
          stage: this.stage,
          artifactPaths: [],
          error: `REVIEW could not write empty findings artifact: ${saved.error.message}`,
        };
      }
    }

    const findingsRelPath = `authoring/drafts/iteration-${this.iteration}/findings.json`;

    appendPipelineLog(ctx.paths, ctx.cwd, ctx.sessionId, {
      recordedAt: nowIso(ctx),
      stage: this.stage,
      stageStatus: toManifestStageStatus("completed"),
      iteration: this.iteration,
      summary: `review complete for iteration ${this.iteration}`,
    });

    saveAuthoringState(ctx.paths, ctx.cwd, ctx.sessionId, {
      pipeline: "multi-stage",
      stage: this.stage,
      stageStatus: "done",
      iteration: this.iteration,
      stallReentryCount: 0,
      artifacts: {
        findings: findingsRelPath,
      },
      blocker: null,
      startedAt: nowIso(ctx),
      updatedAt: nowIso(ctx),
    });

    return {
      status: "completed",
      stage: this.stage,
      artifactPaths: [findingsRelPath],
    };
  }
}
