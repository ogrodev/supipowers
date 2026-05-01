/**
 * RESEARCH stage runner.
 *
 * Fans out per applicable stack using `Promise.all` over `createAgentSession` calls.
 * Each researcher uses `resolveAuthoringSlotModel("researcher", stack, ...)` so
 * per-stack model overrides in `model.json` work uniformly. After all per-stack
 * researchers complete, builds a deterministic SUMMARY.md by concatenating the
 * first ~10 lines of each `<stack>.md`.
 *
 * Resume semantics: if every applicable stack has its `<stack>.md` artifact AND
 * `SUMMARY.md` exists, the stage is skipped.
 */

import * as fs from "node:fs";

import { resolveAuthoringSlot } from "../agent-catalog.js";
import { resolveAuthoringSlotModel } from "../model.js";
import { modelRegistry } from "../../../config/model-registry-instance.js";
import {
  appendPipelineLog,
  deleteResearchStackArtifact,
  loadDiscussArtifact,
  loadIntakeArtifact,
  loadResearchStackArtifact,
  loadScoutArtifact,
  saveAuthoringState,
  saveResearchSummary,
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
  getUltraplanAuthoringIntakePath,
  getUltraplanAuthoringResearchStackPath,
  getUltraplanAuthoringResearchSummaryPath,
  getUltraplanAuthoringScoutPath,
} from "../../project-paths.js";
import { ULTRAPLAN_STACKS } from "../../contracts.js";
import type { UltraPlanBlocker, UltraPlanStackId, UltraPlanApplicability } from "../../../types.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface CandidateStackEntry {
  stack: UltraPlanStackId;
  applicability: UltraPlanApplicability;
}

/**
 * Extract the list of applicable stacks from the intake artifact. Returns an
 * empty array when `candidateStacks` is missing or malformed — the caller treats
 * that as "no stacks applicable" and proceeds with SUMMARY.md only.
 */
function getApplicableStacks(intake: unknown): UltraPlanStackId[] {
  if (
    typeof intake !== "object" ||
    intake === null ||
    !Array.isArray((intake as Record<string, unknown>).candidateStacks)
  ) {
    return [];
  }
  const candidates = (intake as { candidateStacks: CandidateStackEntry[] }).candidateStacks;
  return candidates
    .filter((c) => typeof c === "object" && c !== null && c.applicability === "applicable")
    .map((c) => c.stack);
}

/**
 * Returns true when decisions.jsonl exists and contains at least one non-blank line.
 */
function decisionsHasAtLeastOneLine(decisionsPath: string): boolean {
  if (!fs.existsSync(decisionsPath)) return false;
  try {
    const content = fs.readFileSync(decisionsPath, "utf8");
    return content.split(/\r?\n/).some((line) => line.trim().length > 0);
  } catch {
    return false;
  }
}

function buildResearchAssignment(
  ctx: StageRunnerContext,
  stack: UltraPlanStackId,
  intake: unknown,
  scout: unknown,
  discuss: string | null,
  decisions: string,
): string {
  const parts: string[] = [
    `# UltraPlan authoring · research · ${stack}`,
    ``,
    `Session id: ${ctx.sessionId}`,
    `cwd: ${ctx.cwd}`,
    `Stack: ${stack}`,
    ``,
    `## Intake artifact`,
    "```json",
    JSON.stringify(intake, null, 2),
    "```",
    ``,
    `## Scout artifact`,
    "```json",
    JSON.stringify(scout, null, 2),
    "```",
  ];

  if (discuss) {
    parts.push(``, `## Discuss artifact`, ``, discuss);
  }

  if (decisions.trim().length > 0) {
    parts.push(``, `## Decisions (JSONL)`, "```", decisions.trim(), "```");
  }

  parts.push(
    ``,
    `## Your task`,
    `Research the **${stack}** stack for this UltraPlan session. Identify:`,
    `- Technology choices and library recommendations`,
    `- Architecture patterns appropriate for the goal`,
    `- Integration concerns with existing codebase`,
    `- Risk areas and mitigations`,
    ``,
    `Call \`ultraplan_research_record\` with sessionId=${JSON.stringify(ctx.sessionId)} and stack=${JSON.stringify(stack)}.`,
    `Return after the tool call. Do not append a chat summary.`,
  );

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Stage runner
// ---------------------------------------------------------------------------

export class ResearchStage implements StageRunner {
  readonly stage = "research" as const;

  async isReady(ctx: StageRunnerContext): Promise<boolean> {
    if (!fs.existsSync(getUltraplanAuthoringIntakePath(ctx.paths, ctx.cwd, ctx.sessionId))) {
      return false;
    }
    if (!fs.existsSync(getUltraplanAuthoringScoutPath(ctx.paths, ctx.cwd, ctx.sessionId))) {
      return false;
    }
    const decisionsPath = getUltraplanAuthoringDecisionsPath(ctx.paths, ctx.cwd, ctx.sessionId);
    return decisionsHasAtLeastOneLine(decisionsPath);
  }

  async isComplete(ctx: StageRunnerContext): Promise<boolean> {
    // SUMMARY.md is the canonical completion gate.
    if (
      !fs.existsSync(
        getUltraplanAuthoringResearchSummaryPath(ctx.paths, ctx.cwd, ctx.sessionId),
      )
    ) {
      return false;
    }
    // Every applicable stack must also have its per-stack artifact.
    const intakeResult = loadIntakeArtifact(ctx.paths, ctx.cwd, ctx.sessionId);
    if (!intakeResult.ok) return false;
    const applicableStacks = getApplicableStacks(intakeResult.value);
    return applicableStacks.every((stack) =>
      fs.existsSync(
        getUltraplanAuthoringResearchStackPath(ctx.paths, ctx.cwd, ctx.sessionId, stack),
      ),
    );
  }

  async run(ctx: StageRunnerContext): Promise<StageRunResult> {
    if (!(await this.isReady(ctx))) {
      return {
        status: "failed",
        stage: this.stage,
        artifactPaths: [],
        error:
          "RESEARCH requires intake.json, scout.json, and at least one decision in decisions.jsonl.",
      };
    }

    if (await this.isComplete(ctx)) {
      return {
        status: "skipped",
        stage: this.stage,
        artifactPaths: [],
        details: { reason: "all research artifacts already exist" },
      };
    }

    // Read upstream artifacts.
    const intakeResult = loadIntakeArtifact(ctx.paths, ctx.cwd, ctx.sessionId);
    if (!intakeResult.ok) {
      return {
        status: "failed",
        stage: this.stage,
        artifactPaths: [],
        error: `RESEARCH could not read intake artifact: ${intakeResult.error.message}`,
      };
    }

    const scoutResult = loadScoutArtifact(ctx.paths, ctx.cwd, ctx.sessionId);
    if (!scoutResult.ok) {
      return {
        status: "failed",
        stage: this.stage,
        artifactPaths: [],
        error: `RESEARCH could not read scout artifact: ${scoutResult.error.message}`,
      };
    }

    const discussResult = loadDiscussArtifact(ctx.paths, ctx.cwd, ctx.sessionId);
    const discuss: string | null = discussResult.ok ? discussResult.value : null;

    const decisionsPath = getUltraplanAuthoringDecisionsPath(ctx.paths, ctx.cwd, ctx.sessionId);
    const decisions = fs.existsSync(decisionsPath)
      ? fs.readFileSync(decisionsPath, "utf8")
      : "";

    const applicableStacks = getApplicableStacks(intakeResult.value);
    const notApplicableStacks = ULTRAPLAN_STACKS.filter((s) => !applicableStacks.includes(s));

    // Skip-stack invariant: purge stale research artifacts for non-applicable stacks.
    for (const stack of notApplicableStacks) {
      deleteResearchStackArtifact(ctx.paths, ctx.cwd, ctx.sessionId, stack);
    }

    // Mark running before spawning so resume can find us mid-flight.
    saveAuthoringState(ctx.paths, ctx.cwd, ctx.sessionId, {
      pipeline: "multi-stage",
      stage: this.stage,
      stageStatus: "running",
      iteration: 1,
      stallReentryCount: 0,
      artifacts: {
        intake: "authoring/intake.json",
        scout: "authoring/scout.json",
      },
      blocker: null,
      startedAt: nowIso(ctx),
      updatedAt: nowIso(ctx),
    });

    const slotBinding = resolveAuthoringSlot("researcher", ctx.paths, ctx.cwd);

    // Fan out: one researcher per applicable stack, all in parallel.
    await Promise.all(
      applicableStacks.map(async (stack) => {
        const resolvedModel =
          ctx.modelOverride ??
          resolveAuthoringSlotModel("researcher", stack, ctx.modelConfig, modelRegistry, {
            getModelForRole: (role) => ctx.platform.getModelForRole?.(role) ?? null,
            getCurrentModel: () => ctx.platform.getCurrentModel?.() ?? "unknown",
          });

        const sessionOpts: Record<string, unknown> = {
          cwd: ctx.cwd,
          agentDisplayName: buildAgentDisplayName(this.stage, stack),
          agentId: `ultraplan-authoring-${this.stage}-${stack}-${ctx.sessionId}`,
        };
        if (resolvedModel.model) sessionOpts.model = resolvedModel.model;
        if (resolvedModel.thinkingLevel) sessionOpts.thinkingLevel = resolvedModel.thinkingLevel;

        const agentSession = await ctx.platform.createAgentSession(sessionOpts as never);
        const assignment = [
          slotBinding.definition.prompt.trim(),
          "",
          buildResearchAssignment(
            ctx,
            stack,
            intakeResult.value,
            scoutResult.value,
            discuss,
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

    // Verify every applicable stack produced its artifact.
    const missingStacks = applicableStacks.filter(
      (stack) =>
        !fs.existsSync(
          getUltraplanAuthoringResearchStackPath(ctx.paths, ctx.cwd, ctx.sessionId, stack),
        ),
    );

    if (missingStacks.length > 0) {
      const blocker: UltraPlanBlocker = {
        code: "research-incomplete",
        message: `Research artifacts missing for stacks: ${missingStacks.join(", ")}`,
        scope: "session",
        affected: { stack: null, domainId: null, level: null, scenarioId: null },
        recoverable: true,
        recoveryMode: "retry",
        nextAction:
          "Re-run the research stage; the researcher agent for the affected stacks must call ultraplan_research_record.",
        retryable: true,
        detectedAt: nowIso(ctx),
        details: { missingStacks },
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
        summary: `Research incomplete: missing artifacts for ${missingStacks.join(", ")}`,
        details: { missingStacks },
      });

      return {
        status: "blocked",
        stage: this.stage,
        artifactPaths: [],
        blocker,
      };
    }

    // Build deterministic SUMMARY.md — first ~10 lines of each applicable stack's artifact.
    const summaryParts: string[] = [];
    for (const stack of applicableStacks) {
      const loaded = loadResearchStackArtifact(ctx.paths, ctx.cwd, ctx.sessionId, stack);
      if (loaded.ok) {
        const excerpt = loaded.value.split("\n").slice(0, 10).join("\n");
        summaryParts.push(`## ${stack}\n\n${excerpt}\n`);
      }
    }
    saveResearchSummary(ctx.paths, ctx.cwd, ctx.sessionId, summaryParts.join("\n"));

    const artifactPaths: string[] = [
      ...applicableStacks.map((s) => `authoring/research/${s}.md`),
      "authoring/research/SUMMARY.md",
    ];

    const researchRefs: { stack: UltraPlanStackId; path: string }[] = applicableStacks.map(
      (s) => ({ stack: s, path: `authoring/research/${s}.md` }),
    );

    appendPipelineLog(ctx.paths, ctx.cwd, ctx.sessionId, {
      recordedAt: nowIso(ctx),
      stage: this.stage,
      stageStatus: toManifestStageStatus("completed"),
      iteration: 1,
      summary: `research completed for stacks: ${applicableStacks.join(", ")}`,
      details: { stacks: applicableStacks },
    });

    saveAuthoringState(ctx.paths, ctx.cwd, ctx.sessionId, {
      pipeline: "multi-stage",
      stage: this.stage,
      stageStatus: "done",
      iteration: 1,
      stallReentryCount: 0,
      artifacts: {
        intake: "authoring/intake.json",
        scout: "authoring/scout.json",
        research: researchRefs,
        researchSummary: "authoring/research/SUMMARY.md",
      },
      blocker: null,
      startedAt: nowIso(ctx),
      updatedAt: nowIso(ctx),
    });

    return {
      status: "completed",
      stage: this.stage,
      artifactPaths,
      details: { stacks: applicableStacks },
    };
  }
}
