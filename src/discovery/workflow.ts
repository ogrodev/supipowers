// src/discovery/workflow.ts
//
// High-level integration helper for workflows. Commands (/supi:review,
// /supi:plan, /supi:qa, /supi:fix-pr) adopt discovery by calling
// `suggestCandidatesForWorkflow` with the context they already have. The
// helper composes the deterministic ranker, optional LSP augmentation, and
// a concise rationale formatter so workflows don't wire the pieces
// themselves.
//
// The helper is safe-by-default: when no inputs are provided, it returns
// an empty result rather than scanning the whole repo. Workflows that want
// a full filesystem pool should call `discoverFromSources` directly.

import { rankDiscoveryCandidates, type DiscoveryCandidate, type DiscoveryInput } from "./rank.js";
import { rankWithLspAugmentation, type LspSymbolLocation } from "./lsp.js";

export interface WorkflowDiscoveryInput extends Omit<DiscoveryInput, "candidatePool"> {
  /**
   * Optional pre-filtered candidate pool (e.g. tracked files for a workspace
   * target). When omitted, only changedFiles + externalSignals seed the pool.
   */
  candidatePool?: string[];
  /**
   * Optional LSP symbol lookup. When provided, LSP hits are folded in as
   * external signals; failures degrade to the non-LSP ranking.
   */
  querySymbols?: (query: string) => LspSymbolLocation[] | Promise<LspSymbolLocation[]>;
}

export interface WorkflowDiscoveryResult {
  candidates: DiscoveryCandidate[];
  /** True when LSP augmentation ran successfully. False when disabled or it threw. */
  lspUsed: boolean;
  /** Short formatted summary lines suitable for notify / log / prompt injection. */
  summaryLines: string[];
}

function formatSummary(candidates: DiscoveryCandidate[], maxLines = 5): string[] {
  return candidates.slice(0, maxLines).map((c) => {
    const why = c.rationale.join("; ");
    return `${c.path} (score ${c.score}) — ${why}`;
  });
}

/**
 * Produce ranked candidates for a workflow. Always safe to call — returns
 * empty candidates when no signals are provided. Prefer this over calling
 * `rankDiscoveryCandidates` / `rankWithLspAugmentation` directly so every
 * workflow uses the same composition and rationale format.
 */
export async function suggestCandidatesForWorkflow(
  input: WorkflowDiscoveryInput,
): Promise<WorkflowDiscoveryResult> {
  if (input.querySymbols) {
    const result = await rankWithLspAugmentation({
      cwd: input.cwd,
      repoRoot: input.repoRoot,
      query: input.query,
      changedFiles: input.changedFiles,
      candidatePool: input.candidatePool,
      externalSignals: input.externalSignals,
      limit: input.limit,
      querySymbols: input.querySymbols,
    });
    return {
      candidates: result.candidates,
      lspUsed: result.lspAvailable && result.lspHitCount > 0,
      summaryLines: formatSummary(result.candidates),
    };
  }

  const ranked = rankDiscoveryCandidates({
    cwd: input.cwd,
    repoRoot: input.repoRoot,
    query: input.query,
    changedFiles: input.changedFiles,
    candidatePool: input.candidatePool,
    externalSignals: input.externalSignals,
    limit: input.limit,
  });

  return {
    candidates: ranked.candidates,
    lspUsed: false,
    summaryLines: formatSummary(ranked.candidates),
  };
}
