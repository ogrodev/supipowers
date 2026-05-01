/**
 * INTAKE stage runner.
 *
 * Receives the user's seed prompt (captured by the bare-entry TUI or `plan "..."` args) and
 * spawns a single `createAgentSession` running the `intake` slot agent. The agent performs
 * **structured extraction only** — it does not chat-interrogate the user, pick libraries, or
 * generate scenarios. Its single side-effect is one call to `ultraplan_intake_record` which
 * persists `<session>/authoring/intake.json`.
 *
 * Resume semantics: if the intake artifact already exists on disk and validates, the stage
 * is `skipped`. Otherwise it runs from scratch — re-running INTAKE is safe because the
 * artifact is overwritten atomically.
 */

import * as fs from "node:fs";

import {
  resolveAuthoringSlot,
} from "../agent-catalog.js";
import { resolveAuthoringSlotModel } from "../model.js";
import { modelRegistry } from "../../../config/model-registry-instance.js";
import {
  appendPipelineLog,
  loadIntakeArtifact,
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
} from "../../project-paths.js";

/**
 * Inputs unique to INTAKE: the seed prompt that the user typed when they invoked
 * `/supi:ultraplan` (bare or via `plan "..."`).
 */
export interface IntakeStageInput {
  seedPrompt: string;
}

/**
 * The intake assignment is fully deterministic. We render the agent's prompt below and pass
 * it verbatim to `session.prompt`. The agent's system prompt (the slot's markdown body)
 * already explains the structured-extraction contract.
 */
function buildIntakeAssignment(ctx: StageRunnerContext, input: IntakeStageInput): string {
  return [
    `# UltraPlan authoring · intake`,
    ``,
    `Session id: ${ctx.sessionId}`,
    `cwd: ${ctx.cwd}`,
    ``,
    `## Seed prompt (verbatim)`,
    "",
    "```",
    input.seedPrompt,
    "```",
    ``,
    `## Your task`,
    `Extract the implementation goal as structured fields. Do not chat with the user. Do not pick libraries. Do not generate scenarios.`,
    ``,
    `Call \`ultraplan_intake_record\` exactly once with sessionId=${JSON.stringify(ctx.sessionId)} and these fields:`,
    `- title: short session title (5\u201310 words)`,
    `- goal: one-line implementation goal`,
    `- candidateStacks: per-stack applicability (\"applicable\" or \"not-applicable\") for frontend / backend / infrastructure`,
    `- rawUserNotes: the verbatim seed prompt`,
    `- deferredIdeas: anything in the seed that is out of scope for this session`,
    ``,
    `Return after the tool call. Do not append a chat summary.`,
  ].join("\n");
}

export class IntakeStage implements StageRunner {
  readonly stage = "intake" as const;

  constructor(private readonly input: IntakeStageInput) {}

  async isReady(_ctx: StageRunnerContext): Promise<boolean> {
    // INTAKE has no upstream artifacts; it's always ready as long as a seed prompt was
    // provided.
    return this.input.seedPrompt.trim().length > 0;
  }

  async isComplete(ctx: StageRunnerContext): Promise<boolean> {
    const artifactPath = getUltraplanAuthoringIntakePath(ctx.paths, ctx.cwd, ctx.sessionId);
    if (!fs.existsSync(artifactPath)) return false;
    const loaded = loadIntakeArtifact(ctx.paths, ctx.cwd, ctx.sessionId);
    return loaded.ok;
  }

  async run(ctx: StageRunnerContext): Promise<StageRunResult> {
    if (!(await this.isReady(ctx))) {
      return {
        status: "failed",
        stage: this.stage,
        artifactPaths: [],
        error: "INTAKE has no seed prompt; supply one via /supi:ultraplan plan \"...\" or the TUI input.",
      };
    }

    if (await this.isComplete(ctx)) {
      return {
        status: "skipped",
        stage: this.stage,
        artifactPaths: ["authoring/intake.json"],
        details: { reason: "intake artifact already exists" },
      };
    }

    const slotBinding = resolveAuthoringSlot("intake", ctx.paths, ctx.cwd);
    const resolvedModel =
      ctx.modelOverride ?? resolveAuthoringSlotModel(
        "intake",
        null,
        ctx.modelConfig,
        modelRegistry,
        {
          getModelForRole: (role) => ctx.platform.getModelForRole?.(role) ?? null,
          getCurrentModel: () => ctx.platform.getCurrentModel?.() ?? "unknown",
        },
      );

    // Mark the stage running on disk before spawning, so resume can find it mid-flight.
    saveAuthoringState(ctx.paths, ctx.cwd, ctx.sessionId, {
      pipeline: "multi-stage",
      stage: this.stage,
      stageStatus: "running",
      iteration: 1,
      stallReentryCount: 0,
      artifacts: {},
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
      buildIntakeAssignment(ctx, this.input),
    ].join("\n");

    try {
      await agentSession.prompt(assignment, { expandPromptTemplates: false });
    } finally {
      await agentSession.dispose();
    }

    // Verify the agent actually wrote the artifact. If the tool call didn't happen, surface
    // a structured failure rather than silently advancing.
    const verified = await this.isComplete(ctx);
    if (!verified) {
      return {
        status: "failed",
        stage: this.stage,
        artifactPaths: [],
        error: "INTAKE agent finished without persisting an intake artifact (ultraplan_intake_record was not called).",
      };
    }

    appendPipelineLog(ctx.paths, ctx.cwd, ctx.sessionId, {
      recordedAt: nowIso(ctx),
      stage: this.stage,
      stageStatus: toManifestStageStatus("completed"),
      iteration: 1,
      summary: "intake artifact recorded",
      details: { model: resolvedModel.model ?? null },
    });

    saveAuthoringState(ctx.paths, ctx.cwd, ctx.sessionId, {
      pipeline: "multi-stage",
      stage: this.stage,
      stageStatus: "done",
      iteration: 1,
      stallReentryCount: 0,
      artifacts: { intake: "authoring/intake.json" },
      blocker: null,
      startedAt: nowIso(ctx),
      updatedAt: nowIso(ctx),
    });

    return {
      status: "completed",
      stage: this.stage,
      artifactPaths: ["authoring/intake.json"],
      details: { model: resolvedModel.model ?? null },
    };
  }
}
