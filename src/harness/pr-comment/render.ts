/**
 * Pure renderer for the harness PR sticky comment.
 *
 * No IO, no clock — every output depends only on `input`. This makes the renderer
 * exhaustively unit-testable and reproducible. All UI lives here; the gh poster is a
 * dumb pipe.
 *
 * Layout (Proposal A, locked in design conversation):
 *   1. marker line (HTML comment, machine-parseable)
 *   2. status banner (emoji + score + delta + blocked flag)
 *   3. one-sentence summary
 *   4. failed checks (auto-expanded <details open>) — per-check invariant + finding table
 *   5. passed checks (collapsed <details>) — single-line list
 *   6. scorecard table — dimensions × {score, Δ, open, resolved, wontfix}
 *   7. optional trend line / collapsible
 *   8. footer h6 — floor · session · links · attribution
 */

import type {
  HarnessScoreDimension,
  HarnessValidateCheck,
  HarnessValidateFinding,
  HarnessValidateReport,
} from "../../types.js";
import { deriveStatus, renderMarker } from "./status.js";
import type {
  PrCommentDimensionDelta,
  PrCommentPreviousScore,
  PrCommentStatus,
  PrCommentTrendPoint,
  RenderInput,
  RenderResult,
} from "./types.js";

const STATUS_EMOJI: Readonly<Record<PrCommentStatus, string>> = {
  passed: "🟢",
  warned: "🟡",
  failed: "🔴",
};

const SEVERITY_EMOJI: Readonly<Record<HarnessValidateFinding["severity"], string>> = {
  error: "🛑",
  warning: "⚠",
  info: "ℹ",
};

const DIMENSION_LABELS: Readonly<Record<HarnessScoreDimension["name"], string>> = {
  duplicates: "Duplicates",
  deadCode: "Dead code",
  layerViolations: "Layer violations",
  other: "Other",
};

/** Render a complete PR comment body for a validate report. */
export function renderHarnessPrComment(input: RenderInput): RenderResult {
  const status = deriveStatus(input.report);
  const scoreDelta = computeScoreDelta(input.report.score.strict, input.previousScore);
  const dimensionDeltas = computeDimensionDeltas(
    input.report.score.dimensions,
    input.previousScore?.dimensions ?? null,
  );

  const marker = renderMarker({
    status,
    strict: input.report.score.strict,
    lenient: input.report.score.lenient,
    sessionId: input.sessionId,
    generatedAt: input.generatedAt,
  });

  const sections: string[] = [
    marker,
    "",
    renderBanner(input, status, scoreDelta),
    "",
    renderSummaryLine(input, status),
    "",
  ];

  const failed = input.report.checks.filter((check) => !check.passed);
  const passed = input.report.checks.filter((check) => check.passed);

  if (failed.length > 0) {
    sections.push(renderFailedChecks(failed, input.report));
    sections.push("");
  }

  if (passed.length > 0) {
    sections.push(renderPassedChecks(passed, failed.length === 0));
    sections.push("");
  }

  sections.push(renderScorecard(input.report.score.dimensions, dimensionDeltas));
  sections.push("");

  const trendSection = renderTrend(input.trend, status);
  if (trendSection) {
    sections.push(trendSection);
    sections.push("");
  }

  sections.push(renderFooter(input));

  return {
    body: sections.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n",
    marker,
    status,
    scoreDelta,
    dimensionDeltas,
  };
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderBanner(input: RenderInput, status: PrCommentStatus, scoreDelta: number): string {
  const emoji = STATUS_EMOJI[status];
  const score = input.report.score;
  const deltaText = scoreDelta === 0 ? "" : ` · \`${formatSignedDelta(scoreDelta)}\``;
  const blockedSuffix = status === "failed" ? " · **blocked**" : "";
  return `## ${emoji} Harness · score **${score.strict}** / **${score.lenient}** strict${deltaText}${blockedSuffix}`;
}

function renderSummaryLine(input: RenderInput, status: PrCommentStatus): string {
  const report = input.report;
  const failedCount = report.checks.filter((c) => !c.passed).length;
  const passedCount = report.checks.filter((c) => c.passed).length;
  const totalNewSlop =
    report.slopScan.duplicates +
    report.slopScan.deadCode +
    report.slopScan.layerViolations +
    report.slopScan.other;

  const parts: string[] = [];
  if (status === "passed") {
    parts.push(`All ${passedCount + failedCount} checks passed.`);
    parts.push(totalNewSlop === 0 ? "No new slop." : `${totalNewSlop} slop finding(s).`);
  } else {
    if (failedCount > 0) {
      parts.push(`${failedCount} check${failedCount === 1 ? "" : "s"} failed`);
    }
    if (totalNewSlop > 0) {
      parts.push(`${totalNewSlop} new slop finding${totalNewSlop === 1 ? "" : "s"}`);
    }
    if (!report.scoreFloorPassed) {
      parts.push(`strict score below floor (${input.scoreFloor.strict})`);
    }
  }
  if (input.baseRef) parts.push(`Base: \`${input.baseRef}\``);
  // Join with `·` for status==passed (period-separated reads weird), but with " · " for
  // failure rows so the eye treats them as distinct facts.
  return parts.join(status === "passed" ? " " : " · ") + (status === "passed" ? "" : ".");
}

function renderFailedChecks(failed: readonly HarnessValidateCheck[], report: HarnessValidateReport): string {
  const blocks: string[] = [];
  blocks.push(`<details open><summary><strong>Failed checks (${failed.length})</strong></summary>`);
  blocks.push("");
  for (const check of failed) {
    blocks.push(`#### ❌ ${check.name}`);
    blocks.push(`**Invariant**: ${check.invariant}`);
    blocks.push(`**What broke**: ${escapeInline(check.summary)}`);
    if (check.name === "anti-slop-scan") {
      // The report carries counters but not the queue entries themselves. Surface the
      // counters and point the reader at the backlog command for actionable detail.
      const slop = report.slopScan;
      blocks.push("");
      blocks.push("| Kind | Count |");
      blocks.push("|---|---:|");
      blocks.push(`| Duplicates | ${slop.duplicates} |`);
      blocks.push(`| Dead code | ${slop.deadCode} |`);
      blocks.push(`| Layer violations | ${slop.layerViolations} |`);
      blocks.push(`| Other | ${slop.other} |`);
      blocks.push("");
      blocks.push("Run `/supi:harness next` to start triage, or `/supi:harness backlog` for the full queue.");
    } else if (check.findings.length > 0) {
      blocks.push("");
      blocks.push(renderFindingTable(check.findings));
    }
    blocks.push("");
  }
  blocks.push("</details>");
  return blocks.join("\n");
}

function renderPassedChecks(passed: readonly HarnessValidateCheck[], collapsed: boolean): string {
  // When everything passed we collapse by default; when there ARE failures, we still
  // collapse the passing list because they're not actionable.
  void collapsed; // kept for symmetry with the design — both modes collapse passing checks
  const names = passed.map((c) => `${c.name} ✅`).join(" · ");
  return [
    `<details><summary>Passed checks (${passed.length})</summary>`,
    "",
    names,
    "</details>",
  ].join("\n");
}

function renderScorecard(
  dimensions: readonly HarnessScoreDimension[],
  deltas: readonly PrCommentDimensionDelta[],
): string {
  const deltaByName = new Map(deltas.map((d) => [d.name, d.strict]));
  const rows: string[] = [];
  rows.push("| Dimension | Score | Δ | Open | Resolved | Wontfix |");
  rows.push("|---|---:|---:|---:|---:|---:|");
  for (const dim of dimensions) {
    const delta = deltaByName.get(dim.name);
    const deltaCell = delta === undefined || delta === 0 ? "—" : formatSignedDelta(delta);
    rows.push(
      `| ${DIMENSION_LABELS[dim.name]} | ${dim.strict} | ${deltaCell} | ${dim.open} | ${dim.resolved} | ${dim.wontfix} |`,
    );
  }
  return rows.join("\n");
}

function renderTrend(
  trend: readonly PrCommentTrendPoint[],
  status: PrCommentStatus,
): string | null {
  if (trend.length < 2) return null;
  const arrow = trend.map((p) => String(p.strict)).join(" → ");
  const line = `Trend (last ${trend.length} runs, strict): \`${arrow}\``;
  // For passing reports, hide trend behind a collapsible to keep the comment lean.
  if (status === "passed") {
    return [
      "<details><summary>Trend</summary>",
      "",
      line,
      "</details>",
    ].join("\n");
  }
  return line;
}

function renderFooter(input: RenderInput): string {
  const segments: string[] = [];
  segments.push(`Score floor: strict ${input.scoreFloor.strict} / lenient ${input.scoreFloor.lenient}`);
  segments.push(`Session \`${shortSessionId(input.sessionId)}\``);
  if (input.runUrl) segments.push(`[logs](${input.runUrl})`);
  if (input.reportArtifactUrl) segments.push(`[full report](${input.reportArtifactUrl})`);
  segments.push("`🤖 /supi:harness validate`");
  return `###### ${segments.join(" · ")}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderFindingTable(findings: readonly HarnessValidateFinding[]): string {
  const rows: string[] = [];
  rows.push("| Severity | File | Message |");
  rows.push("|---|---|---|");
  for (const finding of findings) {
    const file = finding.line ? `\`${finding.file}:${finding.line}\`` : `\`${finding.file}\``;
    rows.push(
      `| ${SEVERITY_EMOJI[finding.severity]} ${finding.severity} | ${file} | ${escapeInline(finding.message)} |`,
    );
  }
  return rows.join("\n");
}

function computeScoreDelta(currentStrict: number, previous: PrCommentPreviousScore | null): number {
  if (!previous) return 0;
  return currentStrict - previous.strict;
}

function computeDimensionDeltas(
  current: readonly HarnessScoreDimension[],
  previous: readonly HarnessScoreDimension[] | null,
): PrCommentDimensionDelta[] {
  if (!previous) {
    return current.map((dim) => ({ name: dim.name, strict: 0 }));
  }
  const prevByName = new Map(previous.map((d) => [d.name, d.strict]));
  return current.map((dim) => {
    const before = prevByName.get(dim.name);
    return { name: dim.name, strict: before === undefined ? 0 : dim.strict - before };
  });
}

function formatSignedDelta(delta: number): string {
  return delta > 0 ? `+${delta}` : String(delta);
}

function shortSessionId(sessionId: string): string {
  // ULIDs are 26 chars; trim for footer readability while staying unique enough to grep.
  if (sessionId.length <= 8) return sessionId;
  return `${sessionId.slice(0, 6)}…${sessionId.slice(-2)}`;
}

function escapeInline(text: string): string {
  // Newlines inside a markdown table cell break the row. Collapse to spaces.
  // Pipe characters must be escaped or they're parsed as column separators.
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}
