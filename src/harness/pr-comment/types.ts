/**
 * Shared types for the harness PR comment subsystem.
 *
 * Pure data shapes only — no IO contracts live here. Keeping them in their own module
 * means the render layer can be imported by tests without dragging the gh poster or env
 * detection along.
 */

import type { HarnessScore, HarnessValidateReport } from "../../types.js";

/**
 * Snapshot of a previous score, sourced from `score-history.jsonl`. Score-history v1
 * carries only the top-level scalars — per-dimension breakdowns are not persisted — so the
 * renderer can compute a banner Δ but must show "—" for dimension columns. The optional
 * `dimensions` field is reserved so a future score-history schema change can widen this
 * without touching call sites.
 */
export interface PrCommentPreviousScore {
  recordedAt: string;
  strict: number;
  lenient: number;
  dimensions?: HarnessScore["dimensions"];
}

/** Status banner derived from a validate report. */
export type PrCommentStatus = "passed" | "warned" | "failed";

/** Trend bucket (oldest-first slice from score-history.jsonl). */
export interface PrCommentTrendPoint {
  ts: string;
  strict: number;
  lenient: number;
}

/** Per-dimension delta computed against the previous score. */
export interface PrCommentDimensionDelta {
  name: HarnessScore["dimensions"][number]["name"];
  /** Strict-score delta vs previous. 0 when no baseline. */
  strict: number;
}

/** Inputs to the pure renderer. */
export interface RenderInput {
  report: HarnessValidateReport;
  /** Last score before the current one (drop the current entry). null on first run. */
  previousScore: PrCommentPreviousScore | null;
  /** Trend slice, oldest-first. May be empty. */
  trend: readonly PrCommentTrendPoint[];
  /** Score floor configured on the harness (from `HarnessHookConfig.score_floor`). */
  scoreFloor: { strict: number; lenient: number };
  sessionId: string;
  /** Optional URL to the workflow run for the footer. */
  runUrl?: string;
  /** Optional URL to the raw validate-report.json artifact. */
  reportArtifactUrl?: string;
  /** "main@a1b2c3d" style label for the base ref in the summary line. */
  baseRef?: string;
  /** ISO timestamp used in the marker. Tests pass a fixed value. */
  generatedAt: string;
}

/** Output of the pure renderer. */
export interface RenderResult {
  /** GitHub-flavoured markdown. First line is exactly `marker`. */
  body: string;
  /** Single-line HTML comment containing every machine-parseable field. */
  marker: string;
  status: PrCommentStatus;
  /** Strict-score delta vs previous. 0 when no baseline. */
  scoreDelta: number;
  /** Per-dimension deltas, parallel to `report.score.dimensions`. */
  dimensionDeltas: readonly PrCommentDimensionDelta[];
}
