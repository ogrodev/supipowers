// src/discovery/lsp.ts
//
// LSP-assisted discovery: convert symbol search results into external
// signals the ranker consumes. When LSP is unavailable or the symbol
// lookup returns nothing, falls through cleanly — callers should never
// require LSP for discovery to work.
//
// This module deliberately does not talk to LSP directly. Callers pass in
// a `querySymbols` callback so the same function can be driven by:
//   - the live platform LSP bridge in production
//   - a deterministic fixture in tests

import type { DiscoveryCandidate } from "./rank.js";
import { rankDiscoveryCandidates, type DiscoveryInput } from "./rank.js";

export interface LspSymbolLocation {
  /** Repo-relative path where the symbol is defined or referenced. */
  path: string;
  /** Short reason string attached to the candidate. */
  reason: string;
  /** Extra score beyond the baseline LSP boost. Optional. */
  bonus?: number;
}

export interface LspDiscoveryInput extends DiscoveryInput {
  /**
   * Called with the workflow `query`. Must return a (possibly empty) list
   * of symbol locations. Any thrown error is caught and treated as
   * "LSP unavailable" — discovery still returns a ranked list from the
   * remaining sources.
   */
  querySymbols: (query: string) => LspSymbolLocation[] | Promise<LspSymbolLocation[]>;
}

export interface LspAugmentedResult {
  candidates: DiscoveryCandidate[];
  lspAvailable: boolean;
  lspHitCount: number;
}

const WEIGHT_LSP = 6;

/**
 * Run LSP symbol discovery against the query, fold the hits into external
 * signals, and rank the combined candidate pool. When `querySymbols` throws
 * or returns [], the result is still valid — discovery degrades, not fails.
 */
export async function rankWithLspAugmentation(
  input: LspDiscoveryInput,
): Promise<LspAugmentedResult> {
  let lspAvailable = true;
  let lspHits: LspSymbolLocation[] = [];

  if (input.query && input.query.trim().length > 0) {
    try {
      lspHits = await input.querySymbols(input.query);
    } catch {
      lspAvailable = false;
      lspHits = [];
    }
  }

  const externalSignals: Record<string, { score: number; rationale: string }> = {
    ...(input.externalSignals ?? {}),
  };
  for (const hit of lspHits) {
    const prior = externalSignals[hit.path];
    const score = WEIGHT_LSP + (hit.bonus ?? 0);
    externalSignals[hit.path] = prior
      ? {
          score: prior.score + score,
          rationale: `${prior.rationale}; ${hit.reason}`,
        }
      : { score, rationale: hit.reason };
  }

  const ranked = rankDiscoveryCandidates({
    ...input,
    externalSignals,
  });

  return {
    candidates: ranked.candidates,
    lspAvailable,
    lspHitCount: lspHits.length,
  };
}
