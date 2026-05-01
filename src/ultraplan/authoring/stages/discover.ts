/**
 * DISCOVER stage runner.
 *
 * Spawns a single `createAgentSession` running the `discoverer` slot agent. The agent reads the
 * intake + scout artifacts, then calls `ultraplan_decision_record` for each gray-area question
 * that needs a locked answer before synthesis, and optionally `ultraplan_defer_idea` for items
 * that are out of scope for this session.
 *
 * Resume semantics: skipped when decisions.jsonl exists with at least one line.
 *
 * The stage returns `awaiting-user` (not `completed`): the discover stage gate is a user review
 * step. The pipeline driver (Phase 9) flips the stage to done on user approval.
 *
 * On success the stage also persists `authoring/discuss.md` rendered from all decision records.
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
  saveDiscussArtifact,
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
  getUltraplanAuthoringScoutPath,
} from "../../project-paths.js";

// ---------------------------------------------------------------------------
// Decision record shape (as written by ultraplan_decision_record).
// ---------------------------------------------------------------------------

interface DecisionRecord {
  sessionId?: string;
  area: string;
  question: string;
  decision: string;
  rationale?: string;
  impact?: string[];
  recordedAt?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readDecisionLines(decisionsPath: string): DecisionRecord[] {
  if (!fs.existsSync(decisionsPath)) return [];
  const raw = fs.readFileSync(decisionsPath, "utf8");
  const records: DecisionRecord[] = [];
  for (const line of raw.split("\n").filter((l) => l.trim().length > 0)) {
    try {
      records.push(JSON.parse(line) as DecisionRecord);
    } catch {
      // Skip malformed lines; the stage only needs at least one to proceed.
    }
  }
  return records;
}

function renderDiscussMarkdown(decisions: DecisionRecord[]): string {
  if (decisions.length === 0) return "# Decisions\n\n(none)\n";
  const sections = decisions.map((d) => {
    const lines: string[] = [
      `## ${d.area}`,
      ``,
      `Q: ${d.question}`,
      `A: ${d.decision}`,
    ];
    if (d.rationale) {
      lines.push(``, `Rationale: ${d.rationale}`);
    }
    if (d.impact && d.impact.length > 0) {
      lines.push(``, `Impact: ${d.impact.join(", ")}`);
    }
    lines.push(``);
    return lines.join("\n");
  });
  return `# Decisions\n\n${sections.join("\n")}`;
}

function buildDiscoverAssignment(
  ctx: StageRunnerContext,
  intake: unknown,
  scout: unknown,
): string {
  return [
    `# UltraPlan authoring · discover`,
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
    `## Your task`,
    `Identify every gray area — ambiguous, underspecified, or high-risk decision — that must be`,
    `locked before the synthesis stage can produce a coherent plan. For each gray area, call`,
    `\`ultraplan_decision_record\` with sessionId=${JSON.stringify(ctx.sessionId)} and these fields:`,
    `- area: short label (e.g. 'auth-strategy')`,
    `- question: the exact question that needs a locked answer`,
    `- decision: the locked answer you are recommending`,
    `- rationale: why you chose this answer (optional but strongly recommended)`,
    `- impact: list of domains/scenarios this affects (optional)`,
    ``,
    `For any idea that is clearly out of scope for this session, call \`ultraplan_defer_idea\` with`,
    `sessionId=${JSON.stringify(ctx.sessionId)}, idea, and reason.`,
    ``,
    `Call \`ultraplan_decision_record\` at least once. Return after all tool calls.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Stage runner
// ---------------------------------------------------------------------------

export class DiscoverStage implements StageRunner {
  readonly stage = "discover" as const;

  async isReady(ctx: StageRunnerContext): Promise<boolean> {
    return (
      fs.existsSync(getUltraplanAuthoringIntakePath(ctx.paths, ctx.cwd, ctx.sessionId)) &&
      fs.existsSync(getUltraplanAuthoringScoutPath(ctx.paths, ctx.cwd, ctx.sessionId))
    );
  }

  async isComplete(ctx: StageRunnerContext): Promise<boolean> {
    const decisionsPath = getUltraplanAuthoringDecisionsPath(ctx.paths, ctx.cwd, ctx.sessionId);
    if (!fs.existsSync(decisionsPath)) return false;
    const lines = fs.readFileSync(decisionsPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
    return lines.length > 0;
  }

  async run(ctx: StageRunnerContext): Promise<StageRunResult> {
    if (!(await this.isReady(ctx))) {
      return {
        status: "failed",
        stage: this.stage,
        artifactPaths: [],
        error: "DISCOVER requires both the intake and scout artifacts; run the intake and scout stages first.",
      };
    }

    if (await this.isComplete(ctx)) {
      return {
        status: "skipped",
        stage: this.stage,
        artifactPaths: ["authoring/decisions.jsonl", "authoring/discuss.md"],
        details: { reason: "decisions.jsonl already exists with at least one line" },
      };
    }

    const intakeResult = loadIntakeArtifact(ctx.paths, ctx.cwd, ctx.sessionId);
    if (!intakeResult.ok) {
      return {
        status: "failed",
        stage: this.stage,
        artifactPaths: [],
        error: `DISCOVER could not read intake artifact: ${intakeResult.error.message}`,
      };
    }

    const scoutResult = loadScoutArtifact(ctx.paths, ctx.cwd, ctx.sessionId);
    if (!scoutResult.ok) {
      return {
        status: "failed",
        stage: this.stage,
        artifactPaths: [],
        error: `DISCOVER could not read scout artifact: ${scoutResult.error.message}`,
      };
    }

    const slotBinding = resolveAuthoringSlot("discoverer", ctx.paths, ctx.cwd);
    const resolvedModel =
      ctx.modelOverride ?? resolveAuthoringSlotModel(
        "discoverer",
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
      artifacts: { intake: "authoring/intake.json", scout: "authoring/scout.json" },
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
      buildDiscoverAssignment(ctx, intakeResult.value, scoutResult.value),
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
        error:
          "DISCOVER agent finished without persisting any decision records (ultraplan_decision_record was not called).",
      };
    }

    // Build and persist discuss.md from the decisions.jsonl records.
    const decisionsPath = getUltraplanAuthoringDecisionsPath(ctx.paths, ctx.cwd, ctx.sessionId);
    const decisions = readDecisionLines(decisionsPath);
    const markdown = renderDiscussMarkdown(decisions);
    saveDiscussArtifact(ctx.paths, ctx.cwd, ctx.sessionId, markdown);

    appendPipelineLog(ctx.paths, ctx.cwd, ctx.sessionId, {
      recordedAt: nowIso(ctx),
      stage: this.stage,
      stageStatus: toManifestStageStatus("awaiting-user"),
      iteration: 1,
      summary: `discover stage awaiting user review (${decisions.length} decision(s) recorded)`,
      details: { model: resolvedModel.model ?? null, decisionCount: decisions.length },
    });

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
      },
      blocker: null,
      startedAt: nowIso(ctx),
      updatedAt: nowIso(ctx),
    });

    return {
      status: "awaiting-user",
      stage: this.stage,
      artifactPaths: ["authoring/decisions.jsonl", "authoring/discuss.md"],
      details: { model: resolvedModel.model ?? null, decisionCount: decisions.length },
    };
  }
}
