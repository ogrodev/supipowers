/**
 * Lenient + strict score computation.
 *
 * Score is computed from the persistent slop queue and an optional set of additional
 * dimensions (file health, test health, etc.). Each dimension contributes a 0–100 number
 * to both lenient and strict; the aggregate is the unweighted average.
 *
 * - **Lenient** treats `wontfix` items as resolved — useful for "are we converging?".
 * - **Strict**  treats `wontfix` items as cost — closes the gaming loophole. Release
 *   blocking and CI gates use strict, never lenient.
 *
 * The same input always produces the same output (no Date.now() in the body), so callers
 * who need an `_at` timestamp pass it through `computedAt`.
 */

import type {
  HarnessScore,
  HarnessScoreDimension,
  HarnessSlopQueueEntry,
} from "../../types.js";

// ---------------------------------------------------------------------------
// Dimension builders
// ---------------------------------------------------------------------------

const DIMENSION_NAMES = ["duplicates", "deadCode", "layerViolations", "other"] as const;

interface DimensionBucket {
  open: number;
  resolved: number;
  wontfix: number;
  total: number;
}

function emptyBucket(): DimensionBucket {
  return { open: 0, resolved: 0, wontfix: 0, total: 0 };
}

/**
 * Bucket queue entries into the four canonical dimensions. Unknown kinds map to `other`.
 */
function bucketize(entries: readonly HarnessSlopQueueEntry[]): Record<string, DimensionBucket> {
  const buckets: Record<string, DimensionBucket> = {
    duplicates: emptyBucket(),
    deadCode: emptyBucket(),
    layerViolations: emptyBucket(),
    other: emptyBucket(),
  };

  for (const entry of entries) {
    const bucket = (() => {
      switch (entry.kind) {
        case "duplicate":
          return buckets.duplicates;
        case "dead-code":
          return buckets.deadCode;
        case "layer-violation":
          return buckets.layerViolations;
        default:
          return buckets.other;
      }
    })();
    bucket.total += 1;
    if (entry.state === "open") bucket.open += 1;
    else if (entry.state === "resolved") bucket.resolved += 1;
    else if (entry.state === "wontfix") bucket.wontfix += 1;
  }

  return buckets;
}

/**
 * Per-dimension score: 100 - 100 * (cost / max(total, 1)). Lenient excludes wontfix from
 * cost; strict counts wontfix as cost.
 */
function dimensionScores(bucket: DimensionBucket): { lenient: number; strict: number } {
  const total = Math.max(bucket.total, 1);
  const lenientCost = bucket.open;
  const strictCost = bucket.open + bucket.wontfix;
  return {
    lenient: Math.round(100 * (1 - lenientCost / total)),
    strict: Math.round(100 * (1 - strictCost / total)),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ComputeScoreInput {
  computedAt: string;
  entries: readonly HarnessSlopQueueEntry[];
  /** Optional trend rows (oldest first). Forwarded to the result unchanged. */
  trend?: { ts: string; lenient: number; strict: number }[];
}

export function computeScore(input: ComputeScoreInput): HarnessScore {
  const buckets = bucketize(input.entries);

  const dimensions: HarnessScoreDimension[] = DIMENSION_NAMES.map((name) => {
    const bucket = buckets[name];
    const { lenient, strict } = dimensionScores(bucket);
    return {
      name,
      lenient,
      strict,
      total: bucket.total,
      open: bucket.open,
      resolved: bucket.resolved,
      wontfix: bucket.wontfix,
    };
  });

  // When no entries exist at all, every dimension is 100 — the harness has no recorded
  // failures. We compute an unweighted average; rounding is post-hoc to keep the output
  // close to integer scores even when the input is uniformly empty.
  const lenient = Math.round(
    dimensions.reduce((sum, d) => sum + d.lenient, 0) / dimensions.length,
  );
  const strict = Math.round(
    dimensions.reduce((sum, d) => sum + d.strict, 0) / dimensions.length,
  );

  return {
    computedAt: input.computedAt,
    lenient,
    strict,
    dimensions,
    ...(input.trend ? { trend: input.trend } : {}),
  };
}

/**
 * Compute whether the score passes the configured floor. Strict floor is the binding one
 * (lenient is informational). When `release_blocking` is true and strict < strictFloor, the
 * caller should exit non-zero (CI integration).
 */
export function scoreFloorPassed(
  score: HarnessScore,
  floor: { strict: number; lenient: number },
): { passed: boolean; reason: string } {
  if (score.strict < floor.strict) {
    return {
      passed: false,
      reason: `strict score ${score.strict} below floor ${floor.strict}`,
    };
  }
  if (score.lenient < floor.lenient) {
    return {
      passed: false,
      reason: `lenient score ${score.lenient} below floor ${floor.lenient}`,
    };
  }
  return { passed: true, reason: "score floor satisfied" };
}

// ---------------------------------------------------------------------------
// Badge rendering
// ---------------------------------------------------------------------------

/**
 * Render a tiny SVG shield-style badge. Tests assert deterministic output (no fonts, no
 * external assets). Width is fixed; the strict score determines the fill color.
 */
export function renderScoreBadge(score: HarnessScore): string {
  const color =
    score.strict >= 90 ? "#3fb950"
    : score.strict >= 75 ? "#9e6a03"
    : "#cf222e";
  const text = `harness ${score.strict}`;
  // 88 px width, 20 px height — same as shields.io flat badges.
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="20" role="img" aria-label="harness score">',
    `<rect width="120" height="20" fill="${color}" />`,
    '<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">',
    `<text x="60" y="14">${text}</text>`,
    "</g>",
    "</svg>",
  ].join("");
}
