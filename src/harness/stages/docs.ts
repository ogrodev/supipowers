/**
 * DOCS stage runner.
 *
 * In the `extensive` tier this stage produces one per-layer agent-only knowledge document
 * at `docs/layers/<id>.md` plus a mechanical index at `docs/README.md`. The first 30 LOC
 * of each layer doc (the `## Agent context` section) replaces the addendum the
 * `layer-context-inject` hook would otherwise derive from `docs/architecture.md`.
 *
 * In the `simple` tier the stage is a no-op (returns `skipped`).
 *
 * The stage:
 *   1. Reads the persisted design spec to recover the layer rules.
 *   2. Enumerates files per layer glob (cwd-relative, sorted) and picks representative
 *      files for the subagent input bundle.
 *   3. Computes a deterministic `sourceHash` per layer.
 *   4. Decides which layers need to regen, skip, or are user-edited (preserved).
 *   5. Dispatches subagents in parallel (bounded by config); each subagent calls
 *      `harness_docs_record` exactly once. The tool validates synchronously.
 *   6. On success, atomically promotes the staged docs to the repo: layer files first,
 *      index last.
 *
 * Failure mode: any layer that fails validation twice causes the stage to return
 * `blocked` with a structured per-layer error list. Already-staged layers stay in
 * staging; the index is not written; the previous repo doc tree is untouched.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { Platform } from "../../platform/types.js";
import type {
  HarnessDocsConfig,
  HarnessLayerRule,
} from "../../types.js";
import {
  loadHarnessDesignSpecJson,
  loadHarnessDiscover,
  loadHarnessDocsLayerStaging,
  loadHarnessSession,
  promoteHarnessDocsToRepo,
  saveHarnessDocsIndexStaging,
} from "../storage.js";
import {
  getHarnessRepoDocsLayerPath,
  getHarnessRepoDocsReadmePath,
} from "../project-paths.js";
import {
  type HarnessStageRunResult,
  type HarnessStageRunner,
  type HarnessStageRunnerContext,
  buildHarnessAgentDisplayName,
  nowIso,
} from "../stage-runner.js";
import {
  computeLayerSourceHash,
  type PeerLayerFingerprint,
  type RepresentativeFileFingerprint,
  sha256,
} from "../docs/source-hash.js";
import { decideRegenSet } from "../docs/regen-decision.js";
import {
  renderRepresentativeBlock,
  selectRepresentativeFiles,
  type RepresentativeFileEntry,
} from "../docs/representative-files.js";
import { renderDocsIndex } from "../docs/index-renderer.js";
import { matchesLayerGlob } from "../docs/glob-match.js";
import { resolveDocsConfig } from "../docs/config.js";
import {
  registerDocsLayerExpectation,
  clearDocsLayerExpectation,
} from "../tools.js";

const DOCS_AGENT_PROMPT_PATH = new URL("../default-agents/docs.md", import.meta.url);

export interface DocsStageInput {
  /**
   * Optional override of the tier read from the session manifest. When absent, the stage
   * resolves tier from the session manifest (`docsTier`), falling back to `"simple"`.
   */
  tierOverride?: "simple" | "extensive";
  /** Hard cap on layers to dispatch in this run (defensive; bounded by config too). */
  maxUnitsOverride?: number;
  /** Test-only hook: replace `platform.createAgentSession` for deterministic runs. */
  agentSessionFactory?: (
    platform: Platform,
    options: { cwd: string; agentId: string; agentDisplayName: string },
  ) => Promise<AgentSessionLike>;
}

interface AgentSessionLike {
  prompt(text: string, opts?: { expandPromptTemplates?: boolean }): Promise<void>;
  dispose(): Promise<void>;
}

export class HarnessDocsStage implements HarnessStageRunner {
  readonly stage = "docs" as const;

  constructor(private readonly input: DocsStageInput = {}) {}

  async isReady(ctx: HarnessStageRunnerContext): Promise<boolean> {
    // Requires the design spec to exist (Design must be complete).
    return loadHarnessDesignSpecJson(ctx.paths, ctx.cwd, ctx.sessionId).ok;
  }

  async isComplete(ctx: HarnessStageRunnerContext): Promise<boolean> {
    const tier = await this.resolveTier(ctx);
    if (tier === "simple") return true;

    const designResult = loadHarnessDesignSpecJson(ctx.paths, ctx.cwd, ctx.sessionId);
    if (!designResult.ok) return false;
    const layers = designResult.value.layerRules;
    if (layers.length < 2) return true; // degenerate "single" — no per-layer docs

    const config = resolveDocsConfig(ctx.paths, ctx.cwd);
    const promptVersion = await readPromptVersion();
    const expected = await computeAllLayerSourceHashes({
      ctx,
      layers,
      promptVersion,
    });
    for (const layer of layers) {
      const docPath = getHarnessRepoDocsLayerPath(ctx.paths, ctx.cwd, layer.layer);
      if (!fs.existsSync(docPath)) return false;
      const contents = fs.readFileSync(docPath, "utf8");
      const recorded = extractFrontmatterSourceHash(contents);
      const expectedHash = expected.get(layer.layer);
      if (!recorded || !expectedHash) return false;
      if (recorded !== expectedHash) return false;
    }
    // Index must exist too.
    const indexPath = getHarnessRepoDocsReadmePath(ctx.paths, ctx.cwd);
    if (!fs.existsSync(indexPath)) return false;
    void config; // currently unused at completion-check time; reserved for future LOC checks.
    return true;
  }

  async run(ctx: HarnessStageRunnerContext): Promise<HarnessStageRunResult> {
    const tier = await this.resolveTier(ctx);
    if (tier === "simple") {
      return {
        status: "skipped",
        stage: this.stage,
        artifactPaths: [],
        details: { reason: "docs tier=simple; per-layer docs disabled" },
      };
    }

    const designResult = loadHarnessDesignSpecJson(ctx.paths, ctx.cwd, ctx.sessionId);
    if (!designResult.ok) {
      return {
        status: "blocked",
        stage: this.stage,
        artifactPaths: [],
        blocker: {
          code: "design-spec-missing",
          message: "docs stage requires a persisted design spec.",
        },
      };
    }

    const layers = designResult.value.layerRules;
    if (layers.length === 0) {
      return {
        status: "blocked",
        stage: this.stage,
        artifactPaths: [],
        blocker: {
          code: "layer-rules-missing",
          message: "docs stage requires ≥1 layer rule (Design produces these).",
        },
      };
    }
    if (layers.length < 2) {
      // Degenerate single-layer architecture: Tier 1 docs cover it; nothing to do.
      return {
        status: "skipped",
        stage: this.stage,
        artifactPaths: [],
        details: { reason: "fewer than 2 layer rules; per-layer docs collapse to Tier 1" },
      };
    }

    const config = resolveDocsConfig(ctx.paths, ctx.cwd);
    const maxUnits = this.input.maxUnitsOverride ?? config.max_units;
    if (layers.length > maxUnits) {
      return {
        status: "blocked",
        stage: this.stage,
        artifactPaths: [],
        blocker: {
          code: "too-many-layers",
          message: `docs stage refuses to run on ${layers.length} layers (cap=${maxUnits}); raise harness.docs.max_units or shrink the layer set.`,
        },
      };
    }

    const promptVersion = await readPromptVersion();
    const layerInputs = await buildLayerInputs({ ctx, layers, promptVersion });

    const expectedHashes = new Map(
      layerInputs.map((entry) => [entry.layer.layer, entry.sourceHash] as const),
    );
    const decision = decideRegenSet({
      paths: ctx.paths,
      cwd: ctx.cwd,
      layers,
      expectedSourceHashes: expectedHashes,
    });

    const regenLayers = layerInputs.filter((entry) => decision.regen.includes(entry.layer.layer));

    // Subagent dispatch — bounded parallelism.
    const recordedAt = nowIso(ctx);
    const dispatchErrors: { layerId: string; errors: string[] }[] = [];
    if (regenLayers.length > 0) {
      const limit = config.max_concurrent_subagents ?? regenLayers.length;
      await runWithConcurrencyLimit(regenLayers, Math.max(1, limit), async (entry) => {
        const result = await orchestrateLayerSubagent({
          ctx,
          entry,
          config,
          recordedAt,
          factory: this.input.agentSessionFactory,
        });
        if (!result.ok) {
          dispatchErrors.push({ layerId: entry.layer.layer, errors: result.errors });
        }
      });
    }

    if (dispatchErrors.length > 0) {
      return {
        status: "blocked",
        stage: this.stage,
        artifactPaths: [],
        blocker: {
          code: "doc-generation-failed",
          message: `docs stage failed for ${dispatchErrors.length} layer(s): ${dispatchErrors
            .map((e) => `${e.layerId} → ${e.errors.join("; ")}`)
            .join(" | ")}`,
        },
        details: { failedLayers: dispatchErrors },
      };
    }

    // Render the index from the merged (regenerated + skipped) layer set. User-edited
    // layers are still listed — the index points at the file the user maintains.
    const indexMarkdown = renderDocsIndex({
      layers,
      sessionId: ctx.sessionId,
      generatedAt: recordedAt,
      maxLoc: config.max_index_loc,
    });
    const indexStaged = saveHarnessDocsIndexStaging(
      ctx.paths,
      ctx.cwd,
      ctx.sessionId,
      indexMarkdown,
    );
    if (!indexStaged.ok) {
      return {
        status: "failed",
        stage: this.stage,
        artifactPaths: [],
        error: `failed to stage docs/README.md: ${indexStaged.error.message}`,
      };
    }

    // Atomic promotion. Only promote layers we actually generated this run plus any layers
    // we previously promoted whose staging still exists from a prior run; user-edited
    // layers are not touched. We collect the set from `regen` ∪ `skip` (skip = file is
    // already in the repo and up-to-date; do nothing). The index is the only thing that
    // needs a refresh when skip-only.
    const layersToPromote = decision.regen;
    const promotion = promoteHarnessDocsToRepo(
      ctx.paths,
      ctx.cwd,
      ctx.sessionId,
      layersToPromote,
    );
    if (!promotion.ok) {
      return {
        status: "failed",
        stage: this.stage,
        artifactPaths: [],
        error: `failed to promote docs to repo: ${promotion.error.message}`,
      };
    }

    const artifactPaths: string[] = [
      ...promotion.value.layerPaths.map((p) => path.relative(ctx.cwd, p)),
      path.relative(ctx.cwd, promotion.value.indexPath),
    ];
    return {
      status: "completed",
      stage: this.stage,
      artifactPaths,
      details: {
        regenerated: decision.regen,
        skipped: decision.skip,
        userEdited: decision.userEdited,
        tier: "extensive",
      },
    };
  }

  private async resolveTier(ctx: HarnessStageRunnerContext): Promise<"simple" | "extensive"> {
    if (this.input.tierOverride) return this.input.tierOverride;
    const session = loadHarnessSession(ctx.paths, ctx.cwd, ctx.sessionId);
    if (session.ok && session.value.docsTier) return session.value.docsTier;
    return "simple";
  }
}

// ── Internals ──────────────────────────────────────────────────────────────

interface LayerInputs {
  layer: HarnessLayerRule;
  globPaths: string[];
  representativeEntries: RepresentativeFileEntry[];
  representativeFingerprints: RepresentativeFileFingerprint[];
  sourceHash: string;
}

async function buildLayerInputs(input: {
  ctx: HarnessStageRunnerContext;
  layers: readonly HarnessLayerRule[];
  promptVersion: string;
}): Promise<LayerInputs[]> {
  const allRepoFiles = collectRepoFiles(input.ctx.cwd);
  const goldenPrinciples = readGoldenPrinciples(input.ctx.cwd);
  const peerByLayer = new Map<string, PeerLayerFingerprint[]>();
  for (const layer of input.layers) {
    peerByLayer.set(
      layer.layer,
      input.layers
        .filter((peer) => peer.layer !== layer.layer)
        .map((peer) => ({ id: peer.layer, description: peer.description ?? "" })),
    );
  }

  const out: LayerInputs[] = [];
  for (const layer of input.layers) {
    const globPaths = filterFilesForLayer(allRepoFiles, layer);
    const repSelection = selectRepresentativeFiles({
      cwd: input.ctx.cwd,
      files: globPaths,
    });
    const representativeFingerprints: RepresentativeFileFingerprint[] = repSelection.entries.map(
      (entry) => ({ path: entry.path, contentHash: entry.contentHash }),
    );
    const sourceHash = computeLayerSourceHash({
      layerRule: layer,
      globPaths,
      representativeFiles: representativeFingerprints,
      goldenPrinciples,
      peerLayers: peerByLayer.get(layer.layer) ?? [],
      promptVersion: input.promptVersion,
    });
    out.push({
      layer,
      globPaths,
      representativeEntries: repSelection.entries,
      representativeFingerprints,
      sourceHash,
    });
  }
  return out;
}

async function computeAllLayerSourceHashes(input: {
  ctx: HarnessStageRunnerContext;
  layers: readonly HarnessLayerRule[];
  promptVersion: string;
}): Promise<Map<string, string>> {
  const inputs = await buildLayerInputs(input);
  return new Map(inputs.map((entry) => [entry.layer.layer, entry.sourceHash] as const));
}

function readGoldenPrinciples(cwd: string): string[] {
  const principlesPath = path.join(cwd, "docs", "golden-principles.md");
  if (!fs.existsSync(principlesPath)) return [];
  try {
    const md = fs.readFileSync(principlesPath, "utf8");
    return md
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^\d+\.\s+/.test(line))
      .map((line) => line.replace(/^\d+\.\s+/, ""));
  } catch {
    return [];
  }
}

function filterFilesForLayer(allFiles: readonly string[], layer: HarnessLayerRule): string[] {
  const out: string[] = [];
  for (const file of allFiles) {
    for (const glob of layer.globs) {
      if (matchesLayerGlob(file, glob)) {
        out.push(file);
        break;
      }
    }
  }
  out.sort();
  return out;
}

/**
 * Walk the repo tree once, returning forward-slashed paths relative to `cwd`. Excludes
 * common directories that should never count toward any layer (node_modules, .git,
 * build outputs).
 */
function collectRepoFiles(cwd: string): string[] {
  const out: string[] = [];
  const skip = new Set<string>([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".omp",
    "coverage",
    ".cache",
    ".next",
  ]);

  function walk(absolute: string, relative: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".github") {
        if (skip.has(entry.name)) continue;
        // Allow some dotfiles but skip dotdirs above the cutoff.
      }
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        walk(path.join(absolute, entry.name), path.posix.join(relative, entry.name));
      } else if (entry.isFile()) {
        out.push(relative === "" ? entry.name : path.posix.join(relative, entry.name));
      }
    }
  }

  walk(cwd, "");
  return out;
}

async function readPromptVersion(): Promise<string> {
  try {
    const filePath = path.normalize(decodeURI(DOCS_AGENT_PROMPT_PATH.pathname));
    const contents = fs.readFileSync(filePath, "utf8");
    return sha256(contents);
  } catch {
    // Fallback: a stable string so tests that don't ship the prompt still hash deterministically.
    return crypto.createHash("sha256").update("harness-docs-prompt-fallback", "utf8").digest("hex");
  }
}

async function readPromptText(): Promise<string> {
  try {
    const filePath = path.normalize(decodeURI(DOCS_AGENT_PROMPT_PATH.pathname));
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

interface OrchestrateLayerInput {
  ctx: HarnessStageRunnerContext;
  entry: LayerInputs;
  config: HarnessDocsConfig;
  recordedAt: string;
  factory?: DocsStageInput["agentSessionFactory"];
}

interface OrchestrateLayerResult {
  ok: boolean;
  errors: string[];
}

async function orchestrateLayerSubagent(input: OrchestrateLayerInput): Promise<OrchestrateLayerResult> {
  const { ctx, entry, config } = input;
  registerDocsLayerExpectation(ctx.sessionId, entry.layer.layer, {
    expectedSourceHash: entry.sourceHash,
    maxDocLoc: config.max_per_doc_loc,
    maxAgentContextLoc: config.agent_context_loc,
  });

  try {
    const promptText = await readPromptText();
    const assignment = [
      promptText.trim(),
      "",
      await buildDocsAssignment(ctx, entry, input.recordedAt),
    ].join("\n");

    // First attempt.
    const firstAttempt = await dispatchSubagent({
      platform: ctx.platform,
      ctx,
      entry,
      assignment,
      factory: input.factory,
      attempt: 1,
    });
    if (firstAttempt.ok) return firstAttempt;

    // Single retry-on-overlength: feed the validation errors back.
    const retryAssignment = [
      assignment,
      "",
      "## Previous attempt rejected",
      "Your previous `harness_docs_record` call was rejected with the following errors:",
      ...firstAttempt.errors.map((err) => `- ${err}`),
      "",
      "Fix every error and call `harness_docs_record` again. This is your final attempt.",
    ].join("\n");

    const retry = await dispatchSubagent({
      platform: ctx.platform,
      ctx,
      entry,
      assignment: retryAssignment,
      factory: input.factory,
      attempt: 2,
    });
    return retry;
  } finally {
    clearDocsLayerExpectation(ctx.sessionId, entry.layer.layer);
  }
}

async function dispatchSubagent(input: {
  platform: Platform;
  ctx: HarnessStageRunnerContext;
  entry: LayerInputs;
  assignment: string;
  factory?: DocsStageInput["agentSessionFactory"];
  attempt: number;
}): Promise<OrchestrateLayerResult> {
  const agentId = `harness-docs-${input.ctx.sessionId}-${input.entry.layer.layer}-attempt-${input.attempt}`;
  const agentDisplayName = buildHarnessAgentDisplayName("docs", input.entry.layer.layer);

  let session: AgentSessionLike | null = null;
  try {
    if (input.factory) {
      session = await input.factory(input.platform, {
        cwd: input.ctx.cwd,
        agentId,
        agentDisplayName,
      });
    } else {
      session = await input.platform.createAgentSession({
        cwd: input.ctx.cwd,
        agentId,
        agentDisplayName,
      });
    }
    await session.prompt(input.assignment, { expandPromptTemplates: false });
  } catch (error) {
    return {
      ok: false,
      errors: [
        `subagent dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  } finally {
    if (session) {
      try {
        await session.dispose();
      } catch {
        /* best-effort */
      }
    }
  }

  // Confirm staged output landed; this is the success signal regardless of what the
  // subagent says, because the tool handler is the gatekeeper.
  const staged = loadHarnessDocsLayerStaging(
    input.platform.paths,
    input.ctx.cwd,
    input.ctx.sessionId,
    input.entry.layer.layer,
  );
  if (!staged.ok) {
    return {
      ok: false,
      errors: [
        `subagent did not produce a staged doc for layer ${input.entry.layer.layer} (the harness_docs_record call may have been rejected by the validator).`,
      ],
    };
  }
  return { ok: true, errors: [] };
}

async function buildDocsAssignment(
  ctx: HarnessStageRunnerContext,
  entry: LayerInputs,
  recordedAt: string,
): Promise<string> {
  const discoverResult = loadHarnessDiscover(ctx.paths, ctx.cwd, ctx.sessionId);
  const discover = discoverResult.ok ? discoverResult.value : null;
  const goldenPrinciples = readGoldenPrinciples(ctx.cwd);
  const designResult = loadHarnessDesignSpecJson(ctx.paths, ctx.cwd, ctx.sessionId);
  const peers = designResult.ok
    ? designResult.value.layerRules
        .filter((peer) => peer.layer !== entry.layer.layer)
        .map((peer) => `- ${peer.layer}: ${peer.description ?? "(no description)"}`)
    : [];

  const lines: string[] = [];
  lines.push(`# Per-layer agent docs assignment · ${entry.layer.layer}`);
  lines.push("");
  lines.push(`Session id: ${ctx.sessionId}`);
  lines.push(`Layer id: ${entry.layer.layer}`);
  lines.push(`Recorded at: ${recordedAt}`);
  lines.push("");
  lines.push("## Layer rule");
  lines.push(`- id: ${entry.layer.layer}`);
  lines.push(`- globs: ${entry.layer.globs.join(", ")}`);
  lines.push(`- description: ${entry.layer.description ?? "(none)"}`);
  lines.push(
    `- permitted imports: ${entry.layer.allowedImports.length > 0 ? entry.layer.allowedImports.join(", ") : "(none)"}`,
  );
  lines.push(
    `- forbidden imports: ${entry.layer.forbiddenImports.length > 0 ? entry.layer.forbiddenImports.join(", ") : "(none)"}`,
  );
  lines.push("");
  lines.push("## All files in this layer");
  if (entry.globPaths.length === 0) {
    lines.push("(none)");
  } else {
    for (const file of entry.globPaths.slice(0, 200)) lines.push(`- ${file}`);
    if (entry.globPaths.length > 200) lines.push(`…and ${entry.globPaths.length - 200} more`);
  }
  lines.push("");
  lines.push("## Representative files");
  lines.push(renderRepresentativeBlock(entry.representativeEntries));
  lines.push("");
  lines.push("## Golden principles (already enforced repo-wide; reference, do not restate)");
  if (goldenPrinciples.length === 0) {
    lines.push("(none recorded)");
  } else {
    for (const principle of goldenPrinciples) lines.push(`- ${principle}`);
  }
  lines.push("");
  lines.push("## Peer layers");
  if (peers.length === 0) lines.push("(none)");
  else lines.push(...peers);
  lines.push("");
  lines.push("## Repo facts");
  lines.push(`- languages: ${discover?.languages.join(", ") ?? "(unknown)"}`);
  lines.push(`- frameworks: ${discover?.frameworks.join(", ") ?? "(unknown)"}`);
  lines.push(`- package manager: ${discover?.packageManagers.join(", ") ?? "(unknown)"}`);
  lines.push("");
  lines.push("## Tool invocation");
  lines.push(`You MUST call harness_docs_record exactly once with sessionId=${ctx.sessionId}, layerId=${entry.layer.layer}, and the full markdown body.`);
  lines.push(`Embed sourceHash: ${entry.sourceHash} verbatim in the frontmatter.`);
  return lines.join("\n");
}

function extractFrontmatterSourceHash(markdown: string): string | null {
  // Skip optional provenance marker line.
  let body = markdown;
  if (body.startsWith("<!--")) {
    const newline = body.indexOf("\n");
    if (newline > 0) body = body.slice(newline + 1);
  }
  if (!body.startsWith("---")) return null;
  const firstNewline = body.indexOf("\n");
  if (firstNewline < 0) return null;
  const closeIdx = body.indexOf("\n---", firstNewline);
  if (closeIdx < 0) return null;
  const inner = body.slice(firstNewline + 1, closeIdx);
  for (const line of inner.split("\n")) {
    const match = line.match(/^sourceHash\s*:\s*(.+)\s*$/);
    if (match) return match[1].trim();
  }
  return null;
}

async function runWithConcurrencyLimit<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const queue = [...items];
  const lanes: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, items.length); i += 1) {
    lanes.push(
      (async () => {
        while (queue.length > 0) {
          const next = queue.shift();
          if (next === undefined) break;
          await worker(next);
        }
      })(),
    );
  }
  await Promise.all(lanes);
}