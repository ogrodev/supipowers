/**
 * APPROVE stage runner.
 *
 * Deterministic disk-only operation — no agent is spawned. Promotes an approved draft to
 * canonical artifacts: writes `authored.json`, `manifest.json` (with `authoring` block
 * cleared and `state: "ready"`), updates `index.json`, and renders `authored.md`.
 *
 * Resume semantics: skipped when `<session>/authored.json` already exists and the
 * manifest's `authoring` block is absent (i.e., the promotion already happened).
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { persistAuthoredUltraPlanSession } from "../../authoring-persist.js";
import { validateUltraPlanAuthoredArtifact } from "../../contracts.js";
import {
  getUltraplanAuthoredJsonPath,
  getUltraplanAuthoredMarkdownPath,
  getUltraplanAuthoringDraftAuthoredJsonPath,
  getUltraplanAuthoringDraftFindingsPath,
  ULTRAPLAN_AUTHORED_JSON_FILENAME,
  ULTRAPLAN_AUTHORED_MARKDOWN_FILENAME,
} from "../../project-paths.js";
import { loadUltraPlanManifest } from "../../storage.js";
import { appendPipelineLog, loadDraftAuthoredJson } from "../storage.js";
import {
  nowIso,
  toManifestStageStatus,
  type StageRunResult,
  type StageRunner,
  type StageRunnerContext,
} from "../stage-runner.js";
import type { UltraPlanAuthoredArtifact } from "../../../types.js";

// ---------------------------------------------------------------------------
// Public input
// ---------------------------------------------------------------------------

export interface ApproveStageInput {
  /** Which iteration's draft to promote. Must match an existing `drafts/iteration-N/` dir. */
  iteration: number;
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

/**
 * Produce a simple human-readable summary of the authored artifact. No external helper
 * exists in the codebase yet, so this renderer is inline.
 */
function renderApprovedMarkdown(authored: UltraPlanAuthoredArtifact): string {
  const lines: string[] = [
    `# ${authored.title}`,
    ``,
    `**Goal:** ${authored.goal}`,
    ``,
  ];

  const applicable = authored.stacks.filter((s) => s.applicability === "applicable");
  if (applicable.length > 0) {
    lines.push(`## Stacks`);
    lines.push(``);
    for (const stack of applicable) {
      const count = stack.domains.reduce(
        (n, d) => n + d.unit.length + d.integration.length + d.e2e.length,
        0,
      );
      lines.push(`### ${stack.stack}`);
      lines.push(``);
      for (const domain of stack.domains) {
        const domainCount =
          domain.unit.length + domain.integration.length + domain.e2e.length;
        lines.push(
          `- **${domain.name}** (${domainCount} scenario${domainCount === 1 ? "" : "s"})`,
        );
        for (const scenario of [...domain.unit, ...domain.integration, ...domain.e2e]) {
          lines.push(`  - ${scenario.title}`);
        }
      }
      lines.push(``);
      lines.push(
        `_${count} total scenario${count === 1 ? "" : "s"}_`,
      );
      lines.push(``);
    }
  }

  lines.push(`---`);
  lines.push(`_Session ID: ${authored.sessionId}_`);
  lines.push(``);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Stage implementation
// ---------------------------------------------------------------------------

export class ApproveStage implements StageRunner {
  readonly stage = "approve" as const;

  constructor(private readonly input: ApproveStageInput) {}

  async isReady(ctx: StageRunnerContext): Promise<boolean> {
    const draftPath = getUltraplanAuthoringDraftAuthoredJsonPath(
      ctx.paths, ctx.cwd, ctx.sessionId, this.input.iteration,
    );
    const findingsPath = getUltraplanAuthoringDraftFindingsPath(
      ctx.paths, ctx.cwd, ctx.sessionId, this.input.iteration,
    );
    return fs.existsSync(draftPath) && fs.existsSync(findingsPath);
  }

  async isComplete(ctx: StageRunnerContext): Promise<boolean> {
    const authoredPath = getUltraplanAuthoredJsonPath(ctx.paths, ctx.cwd, ctx.sessionId);
    if (!fs.existsSync(authoredPath)) return false;
    const manifestResult = loadUltraPlanManifest(ctx.paths, ctx.cwd, ctx.sessionId);
    if (!manifestResult.ok) return false;
    // Complete when the authoring block has been cleared (promotion succeeded).
    return !manifestResult.value.authoring;
  }

  async run(ctx: StageRunnerContext): Promise<StageRunResult> {
    if (!(await this.isReady(ctx))) {
      const draftPath = getUltraplanAuthoringDraftAuthoredJsonPath(
        ctx.paths, ctx.cwd, ctx.sessionId, this.input.iteration,
      );
      const findingsPath = getUltraplanAuthoringDraftFindingsPath(
        ctx.paths, ctx.cwd, ctx.sessionId, this.input.iteration,
      );
      const missingDraft = !fs.existsSync(draftPath);
      return {
        status: "failed",
        stage: this.stage,
        artifactPaths: [],
        error: missingDraft
          ? `APPROVE requires a draft authored.json at iteration ${this.input.iteration}; run the synthesize stage first.`
          : `APPROVE requires findings.json at iteration ${this.input.iteration}; run the review stage first.`,
      };
    }

    if (await this.isComplete(ctx)) {
      return {
        status: "skipped",
        stage: this.stage,
        artifactPaths: [ULTRAPLAN_AUTHORED_JSON_FILENAME, ULTRAPLAN_AUTHORED_MARKDOWN_FILENAME],
        details: { reason: "canonical authored.json already exists and authoring block is cleared" },
      };
    }

    // Step 1: load and validate the draft authored.json.
    const draftResult = loadDraftAuthoredJson(
      ctx.paths, ctx.cwd, ctx.sessionId, this.input.iteration,
    );
    if (!draftResult.ok) {
      return {
        status: "blocked",
        stage: this.stage,
        artifactPaths: [],
        error: `APPROVE could not read draft authored.json at iteration ${this.input.iteration}: ${draftResult.error.message}`,
      };
    }

    const validation = validateUltraPlanAuthoredArtifact(draftResult.value);
    if (!validation.ok) {
      const detail = validation.errors.slice(0, 3).join("; ");
      return {
        status: "blocked",
        stage: this.stage,
        artifactPaths: [],
        error: `APPROVE draft authored.json failed schema validation: ${detail}`,
      };
    }

    const authored: UltraPlanAuthoredArtifact = validation.value;

    // Step 2: load the existing manifest, drop the `authoring` block, set state to "ready".
    const manifestResult = loadUltraPlanManifest(ctx.paths, ctx.cwd, ctx.sessionId);
    if (!manifestResult.ok) {
      return {
        status: "blocked",
        stage: this.stage,
        artifactPaths: [],
        error: `APPROVE could not read the session manifest: ${manifestResult.error.message}`,
      };
    }

    const { authoring: _authBlock, ...baseManifest } = manifestResult.value;
    void _authBlock;
    const canonicalManifest = {
      ...baseManifest,
      state: "ready" as const,
      updatedAt: nowIso(ctx),
    };

    // Step 3: persist authored.json + manifest.json + index.json atomically.
    const persistResult = persistAuthoredUltraPlanSession({
      paths: ctx.paths,
      cwd: ctx.cwd,
      authored,
      manifest: canonicalManifest,
    });

    if (!persistResult.ok) {
      const kind = persistResult.error.kind;
      // session-id-exists is only reachable if a previous run partially succeeded and left
      // a stale index entry with a valid manifest; treat it as a recoverable block.
      return {
        status: "blocked",
        stage: this.stage,
        artifactPaths: [],
        error: `APPROVE failed to persist canonical artifacts (${kind}): session may already be promoted or the index is corrupt.`,
      };
    }

    // Step 4: write authored.md (best-effort — the canonical JSON is already committed).
    const markdownPath = getUltraplanAuthoredMarkdownPath(ctx.paths, ctx.cwd, ctx.sessionId);
    const markdown = renderApprovedMarkdown(authored);
    try {
      fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
      fs.writeFileSync(markdownPath, markdown, "utf8");
    } catch {
      // Non-critical: authored.json is already persisted; md failure is cosmetic.
    }

    // Step 5: append a pipeline-log entry summarising the promotion.
    appendPipelineLog(ctx.paths, ctx.cwd, ctx.sessionId, {
      recordedAt: nowIso(ctx),
      stage: this.stage,
      stageStatus: toManifestStageStatus("completed"),
      iteration: this.input.iteration,
      summary: `approved iteration ${this.input.iteration} to ${ctx.sessionId}`,
      details: {
        authoredPath: persistResult.authoredPath,
        manifestPath: persistResult.manifestPath,
        indexPath: persistResult.indexPath,
      },
    });

    return {
      status: "completed",
      stage: this.stage,
      artifactPaths: [ULTRAPLAN_AUTHORED_JSON_FILENAME, ULTRAPLAN_AUTHORED_MARKDOWN_FILENAME],
      details: { iteration: this.input.iteration },
    };
  }
}
