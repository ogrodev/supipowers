// src/context/savings.ts
//
// Pure rendering for the L1 "Savings" panel and its drilldown report. The
// command (`/supi:context`) wires the rendered lines into the existing TUI;
// this module never touches `ctx.ui`, never reads files, and never opens DBs
// itself — it queries the `MetricsStore` accessors that Chunk 1 added.
//
// Ownership rule: the `Metrics DB: <abs-path>` footer is **not** part of any
// function exported here. The consumer (`handleContext`) appends it once,
// immediately after the savings lines, so no caller can produce a duplicate.

import { canonicalToolName } from "../context-mode/tool-name.js";
import type { MetricsStore } from "../context-mode/metrics-store.js";
import { estimateTokens, formatSize } from "./analyzer.js";

/** Format token counts with a k-suffix, mirroring `optimize-context.ts:13`. */
function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
  return String(tokens);
}

/** Format a millisecond delta as a coarse "Xh ago" / "Ym ago" string. */
function relativeTime(startedAtMs: number | null, now = Date.now()): string {
  if (startedAtMs === null) return "unknown";
  const delta = Math.max(0, now - startedAtMs);
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const FALLBACK_LINE = "Measurement unavailable — see /supi:doctor";

const FIRST_RUN_NOTICE_PREFIX = "Measurement enabled. Data lives at ";
const FIRST_RUN_NOTICE_SUFFIX = ". Use /supi:clear to reset.";

/**
 * Single-line first-run notice. Returns `null` once the marker has been
 * persisted, or when `store` is null (degraded mode — no marker to update).
 */
export function getFirstRunNotice(
  store: MetricsStore | null,
  projectSlug: string,
  dbAbsPath: string,
): string | null {
  if (!store) return null;

  let meta;
  try {
    meta = store.getProjectMeta(projectSlug);
  } catch {
    return null;
  }

  if (meta?.first_run_notice_shown_at != null) return null;

  try {
    store.setFirstRunNoticeShown(projectSlug);
  } catch {
    // If we can't persist, surfacing once vs forever is acceptable trade-off;
    // failing closed (no notice) is the safer default.
    return null;
  }

  return `${FIRST_RUN_NOTICE_PREFIX}${dbAbsPath}${FIRST_RUN_NOTICE_SUFFIX}`;
}

/** Inputs to `buildSavingsLines`. Pure data; no store handles. */
export interface SavingsPanelInput {
  session: { id: string; startedAt: number | null; rowCount: number };
  totals: {
    beforeBytes: number;
    afterBytes: number;
    saved: number;
    tokensEstimated: number;
  };
  perCompressor: Array<{ compressor: string; saved: number; calls: number }>;
  uniqueSourceShare: number;
}

function shortSessionId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 8)}\u2026`;
}

/**
 * Render the four savings lines for the `/supi:context` panel:
 *   1. Session: <id> | Started: <relative> | Compressors tracked: <n>
 *   2. Saved this session: <bytes> (~<tokens> tokens estimated)
 *   3. Top compressors: <compressor1> -<bytes1> · <compressor2> -<bytes2> · <compressor3> -<bytes3>
 *   4. Unique-source share: <pct>% (lower = more re-reads)
 *
 * The consumer is responsible for appending the `Metrics DB: <abs-path>`
 * footer; this function deliberately does not emit it.
 */
export function buildSavingsLines(input: SavingsPanelInput): string[] {
  const tracked = new Set(input.perCompressor.map((t) => t.compressor)).size;
  const sessionLine =
    `Session: ${shortSessionId(input.session.id)}` +
    ` | Started: ${relativeTime(input.session.startedAt)}` +
    ` | Compressors tracked: ${tracked}`;

  const savedLine =
    `Saved this session: ${formatSize(input.totals.saved)}` +
    ` (~${formatTokens(input.totals.tokensEstimated)} tokens estimated)`;

  let topLine: string;
  if (input.perCompressor.length === 0) {
    topLine = "Top compressors: (none)";
  } else {
    const top3 = input.perCompressor.slice(0, 3).map((t) => {
      const display = canonicalToolName(t.compressor);
      return `${display} -${formatSize(t.saved)}`;
    });
    topLine = `Top compressors: ${top3.join(" \u00b7 ")}`;
  }

  const sharePct = Math.round(input.uniqueSourceShare * 100);
  const shareLine = `Unique-source share: ${sharePct}% (lower = more re-reads)`;

  return [sessionLine, savedLine, topLine, shareLine];
}

/**
 * Convenience renderer when the consumer has direct access to a store. When
 * `store` is null, returns just the session line and the fallback line so the
 * panel still surfaces *something* the user can act on. The `Metrics DB`
 * footer is always appended by the consumer regardless of which branch fires.
 */
export function buildSavingsLinesFromStore(
  store: MetricsStore | null,
  sessionId: string,
  sessionStartedAtMs: number | null,
  _dbAbsPath: string,
): string[] {
  if (!store) {
    const sessionLine =
      `Session: ${shortSessionId(sessionId)}` +
      ` | Started: ${relativeTime(sessionStartedAtMs)}` +
      ` | Compressors tracked: 0`;
    return [sessionLine, FALLBACK_LINE];
  }

  const totals = store.getSessionTotals(sessionId);
  const perCompressor = store.getTopProcessors(sessionId, 5).map((entry) => ({
    compressor: entry.processor,
    saved: entry.saved,
    calls: entry.calls,
  }));
  const uniqueSourceShare = store.getUniqueSourceShare(sessionId);
  const tokensEstimated = estimateTokens("x".repeat(Math.max(0, totals.saved)));

  return buildSavingsLines({
    session: {
      id: sessionId,
      startedAt: sessionStartedAtMs,
      rowCount: totals.rowCount,
    },
    totals: {
      beforeBytes: totals.beforeBytes,
      afterBytes: totals.afterBytes,
      saved: totals.saved,
      tokensEstimated,
    },
    perCompressor,
    uniqueSourceShare,
  });
}

/**
 * Markdown drilldown for a single savings line. Reused by the
 * `writeReport`/`openInEditor` pipeline already in `/supi:context`.
 */
export function formatSavingsReport(input: SavingsPanelInput): string {
  const tracked = new Set(input.perCompressor.map((t) => t.compressor)).size;
  const lines: string[] = [];
  lines.push("# Session savings");
  lines.push("");
  lines.push(`- Session: ${input.session.id}`);
  lines.push(`- Started: ${relativeTime(input.session.startedAt)}`);
  lines.push(`- Rows recorded: ${input.session.rowCount}`);
  lines.push(`- Compressors tracked: ${tracked}`);
  lines.push("");

  lines.push("## Totals");
  lines.push("");
  lines.push(`- Before: ${formatSize(input.totals.beforeBytes)}`);
  lines.push(`- After: ${formatSize(input.totals.afterBytes)}`);
  lines.push(`- Saved: ${formatSize(input.totals.saved)}`);
  lines.push(`- Tokens estimated: ~${formatTokens(input.totals.tokensEstimated)}`);
  lines.push("");

  lines.push("## Top compressors");
  lines.push("");
  if (input.perCompressor.length === 0) {
    lines.push("(no compressors tracked yet)");
  } else {
    for (const t of input.perCompressor) {
      lines.push(
        `- ${canonicalToolName(t.compressor)} — ${formatSize(t.saved)} saved across ${t.calls} call${t.calls === 1 ? "" : "s"}`,
      );
    }
  }
  lines.push("");

  lines.push("## Unique-source share");
  lines.push("");
  const sharePct = Math.round(input.uniqueSourceShare * 100);
  lines.push(`${sharePct}% — lower values mean the agent re-read the same source repeatedly.`);
  lines.push("");

  return lines.join("\n");
}

/** Build a full drilldown report from the live store. Returns null when the
 *  store is unavailable. */
export function formatSavingsReportFromStore(
  store: MetricsStore | null,
  sessionId: string,
  sessionStartedAtMs: number | null,
): string | null {
  if (!store) return null;

  const totals = store.getSessionTotals(sessionId);
  const perCompressor = store.getTopProcessors(sessionId, 10).map((entry) => ({
    compressor: entry.processor,
    saved: entry.saved,
    calls: entry.calls,
  }));
  const uniqueSourceShare = store.getUniqueSourceShare(sessionId);
  const tokensEstimated = estimateTokens("x".repeat(Math.max(0, totals.saved)));

  return formatSavingsReport({
    session: {
      id: sessionId,
      startedAt: sessionStartedAtMs,
      rowCount: totals.rowCount,
    },
    totals: {
      beforeBytes: totals.beforeBytes,
      afterBytes: totals.afterBytes,
      saved: totals.saved,
      tokensEstimated,
    },
    perCompressor,
    uniqueSourceShare,
  });
}

/** Exported test seam so the panel test can assert exact copy. */
export const _internals = {
  FALLBACK_LINE,
  FIRST_RUN_NOTICE_PREFIX,
  FIRST_RUN_NOTICE_SUFFIX,
};
