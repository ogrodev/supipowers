/**
 * SYNTHESIZE stage runner.
 *
 * Spawns a single `createAgentSession` running the `planner` slot agent. The agent reads the
 * intake, scout, discuss, and research-SUMMARY artifacts and calls `ultraplan_synth_draft`
 * exactly once with a full `UltraPlanAuthoredArtifact` payload, persisting it to
 * `<session>/authoring/drafts/iteration-1/authored.json`.
 *
 * Resume semantics: skipped when the iteration-1 draft exists and passes
 * `validateUltraPlanAuthoredArtifact`. Because the editor round-trip and Phase 6 user-gate
 * code advance past this stage externally, `run` returns `awaiting-user` on success — the
 * stage runner never blocks for user input directly.
 */

import * as fs from "node:fs";

import { resolveAuthoringSlot } from "../agent-catalog.js";
import { resolveAuthoringSlotModel } from "../model.js";
import { modelRegistry } from "../../../config/model-registry-instance.js";
import {
  appendPipelineLog,
  loadDiscussArtifact,
  loadDraftAuthoredJson,
  loadIntakeArtifact,
  loadResearchSummary,
  loadScoutArtifact,
  saveAuthoringState,
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
  getUltraplanAuthoringDiscussPath,
  getUltraplanAuthoringDraftAuthoredJsonPath,
  getUltraplanAuthoringDraftAuthoredRelativePath,
  getUltraplanAuthoringIntakePath,
  getUltraplanAuthoringResearchSummaryPath,
  getUltraplanAuthoringScoutPath,
} from "../../project-paths.js";
import { validateUltraPlanAuthoredArtifact } from "../../contracts.js";
import type { UltraPlanBlocker } from "../../../types.js";

// ---------------------------------------------------------------------------
// Assignment builder
// ---------------------------------------------------------------------------

function buildSynthesizeAssignment(
  ctx: StageRunnerContext,
  intake: unknown,
  scout: unknown,
  discuss: string,
  summary: string,
): string {
  return [
    `# UltraPlan authoring · synthesize`,
    ``,
    `Session id: ${ctx.sessionId}`,
    `cwd: ${ctx.cwd}`,
    ``,
    `## Intake artifact (verbatim)`,
    "```json",
    JSON.stringify(intake, null, 2),
    "```",
    ``,
    `## Scout artifact (verbatim)`,
    "```json",
    JSON.stringify(scout, null, 2),
    "```",
    ``,
    `## Discuss notes (verbatim)`,
    "```",
    discuss,
    "```",
    ``,
    `## Research SUMMARY.md (verbatim)`,
    "```",
    summary,
    "```",
    ``,
    `## Your task`,
    `Using the four artifacts above, produce a complete \`UltraPlanAuthoredArtifact\` for this session.`,
    ``,
    `Call \`ultraplan_synth_draft\` exactly once with:`,
    `- sessionId: ${JSON.stringify(ctx.sessionId)}`,
    `- iteration: 1`,
    `- authored: the full UltraPlanAuthoredArtifact JSON object`,
    `- manifest: the draft manifest JSON object`,
    ``,
    `Do not chat. Do not append a summary. Return after the tool call.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Stage runner
// ---------------------------------------------------------------------------

export class SynthesizeStage implements StageRunner {
  readonly stage = "synthesize" as const;

  async isReady(ctx: StageRunnerContext): Promise<boolean> {
    return (
      fs.existsSync(getUltraplanAuthoringIntakePath(ctx.paths, ctx.cwd, ctx.sessionId)) &&
      fs.existsSync(getUltraplanAuthoringScoutPath(ctx.paths, ctx.cwd, ctx.sessionId)) &&
      fs.existsSync(getUltraplanAuthoringDiscussPath(ctx.paths, ctx.cwd, ctx.sessionId)) &&
      fs.existsSync(getUltraplanAuthoringResearchSummaryPath(ctx.paths, ctx.cwd, ctx.sessionId))
    );
  }

  async isComplete(ctx: StageRunnerContext): Promise<boolean> {
    const jsonPath = getUltraplanAuthoringDraftAuthoredJsonPath(ctx.paths, ctx.cwd, ctx.sessionId, 1);
    if (!fs.existsSync(jsonPath)) return false;
    const loaded = loadDraftAuthoredJson(ctx.paths, ctx.cwd, ctx.sessionId, 1);
    if (!loaded.ok) return false;
    return validateUltraPlanAuthoredArtifact(loaded.value).ok;
  }

  async run(ctx: StageRunnerContext): Promise<StageRunResult> {
    if (!(await this.isReady(ctx))) {
      return {
        status: "failed",
        stage: this.stage,
        artifactPaths: [],
        error: "SYNTHESIZE requires intake, scout, discuss, and research SUMMARY artifacts; run earlier stages first.",
      };
    }

    if (await this.isComplete(ctx)) {
      return {
        status: "skipped",
        stage: this.stage,
        artifactPaths: [getUltraplanAuthoringDraftAuthoredRelativePath(1)],
        details: { reason: "iteration-1 draft already exists and validates" },
      };
    }

    // Load upstream artifacts. All four must be present (isReady already confirmed existence,
    // but reads can still fail on permission errors or corrupt content).
    const intakeResult = loadIntakeArtifact(ctx.paths, ctx.cwd, ctx.sessionId);
    if (!intakeResult.ok) {
      return {
        status: "failed",
        stage: this.stage,
        artifactPaths: [],
        error: `SYNTHESIZE could not read intake artifact: ${intakeResult.error.message}`,
      };
    }

    const scoutResult = loadScoutArtifact(ctx.paths, ctx.cwd, ctx.sessionId);
    if (!scoutResult.ok) {
      return {
        status: "failed",
        stage: this.stage,
        artifactPaths: [],
        error: `SYNTHESIZE could not read scout artifact: ${scoutResult.error.message}`,
      };
    }

    const discussResult = loadDiscussArtifact(ctx.paths, ctx.cwd, ctx.sessionId);
    if (!discussResult.ok) {
      return {
        status: "failed",
        stage: this.stage,
        artifactPaths: [],
        error: `SYNTHESIZE could not read discuss artifact: ${discussResult.error.message}`,
      };
    }

    const summaryResult = loadResearchSummary(ctx.paths, ctx.cwd, ctx.sessionId);
    if (!summaryResult.ok) {
      return {
        status: "failed",
        stage: this.stage,
        artifactPaths: [],
        error: `SYNTHESIZE could not read research SUMMARY: ${summaryResult.error.message}`,
      };
    }

    const slotBinding = resolveAuthoringSlot("planner", ctx.paths, ctx.cwd);
    const resolvedModel =
      ctx.modelOverride ?? resolveAuthoringSlotModel(
        "planner",
        null,
        ctx.modelConfig,
        modelRegistry,
        {
          getModelForRole: (role) => ctx.platform.getModelForRole?.(role) ?? null,
          getCurrentModel: () => ctx.platform.getCurrentModel?.() ?? "unknown",
        },
      );

    // Mark the stage running before spawning so resume can find it mid-flight.
    saveAuthoringState(ctx.paths, ctx.cwd, ctx.sessionId, {
      pipeline: "multi-stage",
      stage: this.stage,
      stageStatus: "running",
      iteration: 1,
      stallReentryCount: 0,
      artifacts: {
        intake: "authoring/intake.json",
        scout: "authoring/scout.json",
        discuss: "authoring/discuss.md",
        researchSummary: "authoring/research/SUMMARY.md",
      },
      blocker: null,
      startedAt: nowIso(ctx),
      updatedAt: nowIso(ctx),
    });

    const sessionOpts: Record<string, unknown> = {
      cwd: ctx.cwd,
      agentDisplayName: buildAgentDisplayName(this.stage),
      agentId: `ultraplan-authoring-${this.stage}-${ctx.sessionId}`,
    };
    if (resolvedModel.model) sessionOpts.model = resolvedModel.model;
    if (resolvedModel.thinkingLevel) sessionOpts.thinkingLevel = resolvedModel.thinkingLevel;

    const agentSession = await ctx.platform.createAgentSession(sessionOpts as never);
    const assignment = [
      slotBinding.definition.prompt.trim(),
      "",
      buildSynthesizeAssignment(
        ctx,
        intakeResult.value,
        scoutResult.value,
        discussResult.value,
        summaryResult.value,
      ),
    ].join("\n");

    try {
      await agentSession.prompt(assignment, { expandPromptTemplates: false });
    } finally {
      await agentSession.dispose();
    }

    // Verify the agent persisted the draft. Missing file means the tool was never called.
    const draftPath = getUltraplanAuthoringDraftAuthoredJsonPath(ctx.paths, ctx.cwd, ctx.sessionId, 1);
    if (!fs.existsSync(draftPath)) {
      return {
        status: "failed",
        stage: this.stage,
        artifactPaths: [],
        error: "SYNTHESIZE agent finished without persisting a draft (ultraplan_synth_draft was not called).",
      };
    }

    // Load and validate the draft. A malformed payload from the planner is a structured blocker
    // rather than a programming failure — the user or operator can correct it.
    const draftLoaded = loadDraftAuthoredJson(ctx.paths, ctx.cwd, ctx.sessionId, 1);
    if (!draftLoaded.ok) {
      return {
        status: "failed",
        stage: this.stage,
        artifactPaths: [],
        error: `SYNTHESIZE draft could not be read back from disk: ${draftLoaded.error.message}`,
      };
    }

    const validation = validateUltraPlanAuthoredArtifact(draftLoaded.value);
    if (!validation.ok) {
      const blocker: UltraPlanBlocker = {
        code: "synth-draft-invalid",
        message: "Synthesized draft failed schema validation; the planner produced an invalid UltraPlanAuthoredArtifact.",
        scope: "session",
        affected: { stack: null, domainId: null, level: null, scenarioId: null },
        recoverable: true,
        recoveryMode: "retry",
        nextAction: "Re-run the synthesize stage or inspect and fix the draft at authoring/drafts/iteration-1/authored.json.",
        retryable: true,
        detectedAt: nowIso(ctx),
        details: { errors: validation.errors },
      };

      saveAuthoringState(ctx.paths, ctx.cwd, ctx.sessionId, {
        pipeline: "multi-stage",
        stage: this.stage,
        stageStatus: "blocked",
        iteration: 1,
        stallReentryCount: 0,
        artifacts: {
          intake: "authoring/intake.json",
          scout: "authoring/scout.json",
          discuss: "authoring/discuss.md",
          researchSummary: "authoring/research/SUMMARY.md",
        },
        blocker,
        startedAt: nowIso(ctx),
        updatedAt: nowIso(ctx),
      });

      appendPipelineLog(ctx.paths, ctx.cwd, ctx.sessionId, {
        recordedAt: nowIso(ctx),
        stage: this.stage,
        stageStatus: toManifestStageStatus("blocked"),
        iteration: 1,
        summary: "synthesize draft failed schema validation",
        details: { model: resolvedModel.model ?? null },
      });

      return {
        status: "blocked",
        stage: this.stage,
        artifactPaths: [],
        blocker,
      };
    }

    // Success — persist awaiting-user state. The editor round-trip (Phase 6) advances past this.
    saveAuthoringState(ctx.paths, ctx.cwd, ctx.sessionId, {
      pipeline: "multi-stage",
      stage: this.stage,
      stageStatus: "awaiting-user",
      iteration: 1,
      stallReentryCount: 0,
      artifacts: {
        intake: "authoring/intake.json",
        scout: "authoring/scout.json",
        discuss: "authoring/discuss.md",
        researchSummary: "authoring/research/SUMMARY.md",
        draft: getUltraplanAuthoringDraftAuthoredRelativePath(1),
      },
      blocker: null,
      startedAt: nowIso(ctx),
      updatedAt: nowIso(ctx),
    });

    appendPipelineLog(ctx.paths, ctx.cwd, ctx.sessionId, {
      recordedAt: nowIso(ctx),
      stage: this.stage,
      stageStatus: toManifestStageStatus("awaiting-user"),
      iteration: 1,
      summary: "synthesize draft persisted; awaiting user review",
      details: { model: resolvedModel.model ?? null },
    });

    return {
      status: "awaiting-user",
      stage: this.stage,
      artifactPaths: [getUltraplanAuthoringDraftAuthoredRelativePath(1)],
      details: { model: resolvedModel.model ?? null },
    };
  }
}
