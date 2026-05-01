/**
 * SCOUT stage runner.
 *
 * Spawns a single `createAgentSession` running the `scout` slot agent. The agent reads the
 * intake artifact and the repository, then calls `ultraplan_scout_record` exactly once with
 * structured codebase reconnaissance: reusable assets, integration points, conventions per
 * applicable stack, existing test patterns.
 *
 * Resume semantics: skipped when scout artifact exists and validates.
 */

import * as fs from "node:fs";

import { resolveAuthoringSlot } from "../agent-catalog.js";
import { resolveAuthoringSlotModel } from "../model.js";
import { modelRegistry } from "../../../config/model-registry-instance.js";
import {
  appendPipelineLog,
  loadIntakeArtifact,
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
  getUltraplanAuthoringIntakePath,
  getUltraplanAuthoringScoutPath,
} from "../../project-paths.js";

function buildScoutAssignment(ctx: StageRunnerContext, intake: unknown): string {
  return [
    `# UltraPlan authoring \u00b7 scout`,
    ``,
    `Session id: ${ctx.sessionId}`,
    `cwd: ${ctx.cwd}`,
    ``,
    `## Intake artifact (verbatim)`,
    "```json",
    JSON.stringify(intake, null, 2),
    "```",
    ``,
    `## Your task`,
    `Survey the repository to surface what already exists. Use parallel \`task\` / \`search\` / \`find\` calls. Do not pick libraries; that is the researcher's job.`,
    ``,
    `Call \`ultraplan_scout_record\` exactly once with sessionId=${JSON.stringify(ctx.sessionId)} and these fields:`,
    `- reusableAssets: list of { kind, path, note } for files/symbols the implementation can reuse`,
    `- integrationPoints: list of { path, note } for existing modules the new work must integrate with`,
    `- conventionsByStack: { frontend?: string[], backend?: string[], infrastructure?: string[] } \u2014 short imperative bullets for each applicable stack`,
    `- existingTests: file paths of existing tests that establish the project's test patterns`,
    ``,
    `Only include sections for stacks the intake marked applicable. Return after the tool call.`,
  ].join("\n");
}

export class ScoutStage implements StageRunner {
  readonly stage = "scout" as const;

  async isReady(ctx: StageRunnerContext): Promise<boolean> {
    return fs.existsSync(getUltraplanAuthoringIntakePath(ctx.paths, ctx.cwd, ctx.sessionId));
  }

  async isComplete(ctx: StageRunnerContext): Promise<boolean> {
    const artifactPath = getUltraplanAuthoringScoutPath(ctx.paths, ctx.cwd, ctx.sessionId);
    if (!fs.existsSync(artifactPath)) return false;
    const loaded = loadScoutArtifact(ctx.paths, ctx.cwd, ctx.sessionId);
    return loaded.ok;
  }

  async run(ctx: StageRunnerContext): Promise<StageRunResult> {
    if (!(await this.isReady(ctx))) {
      return {
        status: "failed",
        stage: this.stage,
        artifactPaths: [],
        error: "SCOUT requires the intake artifact; run the intake stage first.",
      };
    }

    if (await this.isComplete(ctx)) {
      return {
        status: "skipped",
        stage: this.stage,
        artifactPaths: ["authoring/scout.json"],
        details: { reason: "scout artifact already exists" },
      };
    }

    const intakeResult = loadIntakeArtifact(ctx.paths, ctx.cwd, ctx.sessionId);
    if (!intakeResult.ok) {
      return {
        status: "failed",
        stage: this.stage,
        artifactPaths: [],
        error: `SCOUT could not read intake artifact: ${intakeResult.error.message}`,
      };
    }

    const slotBinding = resolveAuthoringSlot("scout", ctx.paths, ctx.cwd);
    const resolvedModel =
      ctx.modelOverride ?? resolveAuthoringSlotModel(
        "scout",
        null,
        ctx.modelConfig,
        modelRegistry,
        {
          getModelForRole: (role) => ctx.platform.getModelForRole?.(role) ?? null,
          getCurrentModel: () => ctx.platform.getCurrentModel?.() ?? "unknown",
        },
      );

    saveAuthoringState(ctx.paths, ctx.cwd, ctx.sessionId, {
      pipeline: "multi-stage",
      stage: this.stage,
      stageStatus: "running",
      iteration: 1,
      stallReentryCount: 0,
      artifacts: { intake: "authoring/intake.json" },
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
      buildScoutAssignment(ctx, intakeResult.value),
    ].join("\n");

    try {
      await agentSession.prompt(assignment, { expandPromptTemplates: false });
    } finally {
      await agentSession.dispose();
    }

    const verified = await this.isComplete(ctx);
    if (!verified) {
      return {
        status: "failed",
        stage: this.stage,
        artifactPaths: [],
        error: "SCOUT agent finished without persisting a scout artifact (ultraplan_scout_record was not called).",
      };
    }

    appendPipelineLog(ctx.paths, ctx.cwd, ctx.sessionId, {
      recordedAt: nowIso(ctx),
      stage: this.stage,
      stageStatus: toManifestStageStatus("completed"),
      iteration: 1,
      summary: "scout artifact recorded",
      details: { model: resolvedModel.model ?? null },
    });

    saveAuthoringState(ctx.paths, ctx.cwd, ctx.sessionId, {
      pipeline: "multi-stage",
      stage: this.stage,
      stageStatus: "done",
      iteration: 1,
      stallReentryCount: 0,
      artifacts: { intake: "authoring/intake.json", scout: "authoring/scout.json" },
      blocker: null,
      startedAt: nowIso(ctx),
      updatedAt: nowIso(ctx),
    });

    return {
      status: "completed",
      stage: this.stage,
      artifactPaths: ["authoring/scout.json"],
      details: { model: resolvedModel.model ?? null },
    };
  }
}
