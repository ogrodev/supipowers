// src/discovery/rank.ts
//
// Deterministic ranking over a set of candidate paths. Each scoring source
// contributes a weighted score and a rationale line; the final ranking is
// the sum of contributions, sorted desc and then lex for stability.

export interface DiscoveryInput {
  cwd: string;
  /** Absolute or cwd-relative repo root. */
  repoRoot: string;
  /** Free-text workflow query, e.g. "fix the login bug". Used for path-token scoring. */
  query?: string;
  /** Files changed in the current context (git diff, uncommitted, PR scope). */
  changedFiles?: string[];
  /**
   * All discoverable files to consider. If omitted, only `changedFiles` are
   * scored. Callers should keep this list pre-filtered to reasonable size.
   */
  candidatePool?: string[];
  /**
   * Additional per-source boost map: path → { score, rationale }. Used by
   * workflow-specific callers (e.g. fix-pr injecting files mentioned in PR
   * comments).
   */
  externalSignals?: Record<string, { score: number; rationale: string }>;
  /** Cap the returned ranked list. Default: 20. */
  limit?: number;
}

export type DiscoverySource =
  | "changed"
  | "query-path-match"
  | "external-signal"
  | "lsp";

export interface DiscoveryCandidate {
  path: string;
  score: number;
  /** Each source that contributed to the score. */
  sources: DiscoverySource[];
  /** Human-readable reasons explaining the score. */
  rationale: string[];
}

export interface DiscoveryResult {
  candidates: DiscoveryCandidate[];
  /** Every source that touched at least one candidate, for observability. */
  sourcesUsed: DiscoverySource[];
}

// ---------------------------------------------------------------------------
// Source weights. Small and explicit — avoid hidden tuning.
// ---------------------------------------------------------------------------

const WEIGHT_CHANGED = 10;
const WEIGHT_QUERY_TOKEN = 2;
const MIN_QUERY_TOKEN_LENGTH = 4;

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

function tokenize(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9_-]+/)
        .filter((t) => t.length >= MIN_QUERY_TOKEN_LENGTH),
    ),
  ];
}

function countTokenHitsInPath(path: string, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const lower = path.toLowerCase();
  let hits = 0;
  for (const t of tokens) {
    if (lower.includes(t)) hits += 1;
  }
  return hits;
}

/**
 * Rank candidate files. Deterministic given identical input: sort is by
 * score desc, then path asc, so ties resolve stably.
 */
export function rankDiscoveryCandidates(input: DiscoveryInput): DiscoveryResult {
  const changedFiles = new Set((input.changedFiles ?? []).map(normalizePath));
  const pool = new Set<string>([
    ...changedFiles,
    ...(input.candidatePool ?? []).map(normalizePath),
    ...Object.keys(input.externalSignals ?? {}).map(normalizePath),
  ]);

  const queryTokens = input.query ? tokenize(input.query) : [];
  const sourcesUsed = new Set<DiscoverySource>();

  const candidates: DiscoveryCandidate[] = [];
  for (const path of pool) {
    const rationale: string[] = [];
    const sources: DiscoverySource[] = [];
    let score = 0;

    if (changedFiles.has(path)) {
      score += WEIGHT_CHANGED;
      sources.push("changed");
      sourcesUsed.add("changed");
      rationale.push("changed in current context");
    }

    const tokenHits = countTokenHitsInPath(path, queryTokens);
    if (tokenHits > 0) {
      const contribution = tokenHits * WEIGHT_QUERY_TOKEN;
      score += contribution;
      sources.push("query-path-match");
      sourcesUsed.add("query-path-match");
      rationale.push(`path matches ${tokenHits} query token${tokenHits === 1 ? "" : "s"}`);
    }

    const external = input.externalSignals?.[path];
    if (external) {
      score += external.score;
      sources.push("external-signal");
      sourcesUsed.add("external-signal");
      rationale.push(external.rationale);
    }

    if (score > 0) {
      candidates.push({ path, score, sources, rationale });
    }
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.path.localeCompare(b.path);
  });

  const limit = input.limit ?? 20;
  return {
    candidates: candidates.slice(0, limit),
    sourcesUsed: [...sourcesUsed].sort(),
  };
}
