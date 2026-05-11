/**
 * Load the trend baseline from `score-history.jsonl`.
 *
 * The validate stage appends one record per run to this file. We split that history
 * into:
 *   - `previousScore`: the most recent prior entry (so we can compute a delta vs the
 *     score we just wrote), or null when there is nothing to compare against;
 *   - `trend`: the last N entries oldest-first, for the inline sparkline.
 *
 * Score-history v1 records are `{ recordedAt, sessionId, strict, lenient }` (see
 * `src/harness/stages/validate.ts`). Per-dimension breakdowns are NOT persisted, so we
 * surface them as `undefined` and the renderer shows "—" for the dimension Δ column.
 */

import type { PlatformPaths } from "../../platform/types.js";
import type { UltraPlanStorageResult } from "../../types.js";
import { readJsonl } from "../storage.js";
import { getHarnessScoreHistoryPath } from "../project-paths.js";
import type { PrCommentPreviousScore, PrCommentTrendPoint } from "./types.js";

/** Raw score-history record as written by Validate. */
interface ScoreHistoryRecord {
  recordedAt: string;
  sessionId: string;
  strict: number;
  lenient: number;
}

export interface Baseline {
  /** Most recent prior entry. null when history is empty or has only one record. */
  previousScore: PrCommentPreviousScore | null;
  /** Last `limit` entries, oldest first. Empty when no history. */
  trend: readonly PrCommentTrendPoint[];
}

const DEFAULT_TREND_LIMIT = 5;

/**
 * Read score-history.jsonl and split it into (previous, trend).
 *
 * `currentSessionId` is what just ran — we drop ALL trailing records that match it so we
 * never compare a score against itself, even when validate is re-run for the same session.
 *
 * Returns an empty baseline (`previousScore: null`, `trend: []`) when the history file is
 * missing or unreadable. We deliberately swallow IO errors here: a corrupted history file
 * should degrade gracefully to "no baseline" rather than block PR comment generation.
 */
export function loadBaseline(
  paths: PlatformPaths,
  cwd: string,
  options: { currentSessionId?: string; limit?: number } = {},
): Baseline {
  const limit = options.limit ?? DEFAULT_TREND_LIMIT;
  const result: UltraPlanStorageResult<ScoreHistoryRecord[]> = readJsonl<ScoreHistoryRecord>(
    getHarnessScoreHistoryPath(paths, cwd),
  );
  if (!result.ok) {
    return { previousScore: null, trend: [] };
  }
  const records = result.value.filter((record) => isWellFormed(record));

  // Strip the trailing run(s) that belong to the current session so we compare against the
  // PRIOR run. When currentSessionId is omitted (local dry-run with no session context),
  // we treat the most recent record as the baseline.
  let priorEnd = records.length;
  if (options.currentSessionId) {
    while (priorEnd > 0 && records[priorEnd - 1].sessionId === options.currentSessionId) {
      priorEnd -= 1;
    }
  }

  const previousRecord = priorEnd > 0 ? records[priorEnd - 1] : null;
  const previousScore: PrCommentPreviousScore | null = previousRecord
    ? {
        recordedAt: previousRecord.recordedAt,
        strict: previousRecord.strict,
        lenient: previousRecord.lenient,
      }
    : null;

  // Trend is the last `limit` records oldest-first. We include the current run so the
  // sparkline ends with the just-computed score; the renderer can choose whether to
  // highlight it.
  const trendSlice = records.slice(Math.max(0, records.length - limit));
  const trend: PrCommentTrendPoint[] = trendSlice.map((record) => ({
    ts: record.recordedAt,
    strict: record.strict,
    lenient: record.lenient,
  }));

  return { previousScore, trend };
}

function isWellFormed(record: unknown): record is ScoreHistoryRecord {
  if (record === null || typeof record !== "object") return false;
  const r = record as Record<string, unknown>;
  return (
    typeof r.recordedAt === "string" &&
    typeof r.sessionId === "string" &&
    typeof r.strict === "number" &&
    typeof r.lenient === "number" &&
    Number.isFinite(r.strict) &&
    Number.isFinite(r.lenient)
  );
}
