// src/storage/reliability-metrics.ts
//
// Local-first reliability metrics. Each AI-heavy command appends one
// ReliabilityRecord per attempt to .omp/supipowers/reliability/events.jsonl.
// /supi:status and /supi:doctor read these records to surface concrete
// numbers (parse-success rate, blocked rate, retries-per-run, fallback
// counts) instead of vibes.
//
// Storage format: append-only JSONL. One record per line. Robust to partial
// writes — readers skip malformed lines rather than aborting.
//
// Non-goals:
//   - Hosted telemetry (records never leave the project)
//   - Streaming queries (everything is in-memory after read)
//   - Cross-cwd aggregation in a single read (callers pass the cwd they want)

import * as fs from "node:fs";
import * as path from "node:path";
import type { PlatformPaths } from "../platform/types.js";
import type { ReliabilityOutcome, ReliabilityRecord, ReliabilitySummary } from "../types.js";

const EVENTS_FILE = "events.jsonl";
const RELIABILITY_DIR = "reliability";

function getReliabilityDir(paths: PlatformPaths, cwd: string): string {
  return paths.project(cwd, RELIABILITY_DIR);
}

function getEventsPath(paths: PlatformPaths, cwd: string): string {
  return path.join(getReliabilityDir(paths, cwd), EVENTS_FILE);
}

/**
 * Append a single reliability record. Best-effort: failures are swallowed
 * because metrics must never crash the workflow they observe.
 */
export function appendReliabilityRecord(
  paths: PlatformPaths,
  cwd: string,
  record: ReliabilityRecord,
): void {
  try {
    fs.mkdirSync(getReliabilityDir(paths, cwd), { recursive: true });
    fs.appendFileSync(getEventsPath(paths, cwd), JSON.stringify(record) + "\n");
  } catch {
    // Swallow — metrics observability must not break the workflow.
  }
}

/**
 * Read all reliability records for the given cwd. Malformed lines are
 * skipped silently (best-effort recovery). Returns an empty array when the
 * file does not exist yet.
 */
export function readReliabilityRecords(paths: PlatformPaths, cwd: string): ReliabilityRecord[] {
  const file = getEventsPath(paths, cwd);
  if (!fs.existsSync(file)) return [];
  const records: ReliabilityRecord[] = [];
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return [];
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as ReliabilityRecord;
      // Minimal shape check — drop records missing the required fields.
      if (
        typeof parsed?.ts === "string" &&
        typeof parsed.command === "string" &&
        typeof parsed.outcome === "string" &&
        typeof parsed.attempts === "number"
      ) {
        records.push(parsed);
      }
    } catch {
      // Skip malformed line.
    }
  }
  return records;
}

const ZERO_OUTCOME_COUNTS: Record<ReliabilityOutcome, number> = {
  ok: 0,
  blocked: 0,
  "retry-exhausted": 0,
  fallback: 0,
  "agent-error": 0,
};

/**
 * Aggregate records into per-command summaries. Returns one summary per
 * distinct `command` that appears in `records`, sorted by command name.
 */
export function summarizeReliabilityRecords(records: ReliabilityRecord[]): ReliabilitySummary[] {
  const buckets = new Map<string, ReliabilityRecord[]>();
  for (const record of records) {
    const list = buckets.get(record.command) ?? [];
    list.push(record);
    buckets.set(record.command, list);
  }

  const summaries: ReliabilitySummary[] = [];
  for (const [command, list] of buckets) {
    const byOutcome = { ...ZERO_OUTCOME_COUNTS };
    let attemptsTotal = 0;
    let lastRecordedAt: string | null = null;
    for (const r of list) {
      byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
      attemptsTotal += r.attempts;
      if (!lastRecordedAt || r.ts > lastRecordedAt) lastRecordedAt = r.ts;
    }
    summaries.push({
      command,
      total: list.length,
      byOutcome,
      avgAttempts: list.length > 0 ? attemptsTotal / list.length : 0,
      lastRecordedAt,
    });
  }

  summaries.sort((a, b) => a.command.localeCompare(b.command));
  return summaries;
}

/**
 * Convenience: load + summarize in one call.
 */
export function loadReliabilitySummaries(
  paths: PlatformPaths,
  cwd: string,
): ReliabilitySummary[] {
  return summarizeReliabilityRecords(readReliabilityRecords(paths, cwd));
}

const RELIABILITY_OUTCOMES: ReliabilityOutcome[] = [
  "ok",
  "blocked",
  "retry-exhausted",
  "fallback",
  "agent-error",
];

/**
 * Render a concise, aligned reliability section suitable for TUI output.
 * When no records exist yet, returns a single non-alarming empty-state line.
 */
export function formatReliabilitySection(summaries: ReliabilitySummary[]): string[] {
  if (summaries.length === 0) {
    return ["Reliability: no records yet (metrics appear after AI-heavy commands run)."];
  }

  const total = summaries.reduce((n, s) => n + s.total, 0);
  const nameWidth = Math.max(...summaries.map((s) => s.command.length));
  const colWidths: Record<ReliabilityOutcome, number> = { ...ZERO_OUTCOME_COUNTS };
  for (const s of summaries) {
    for (const outcome of RELIABILITY_OUTCOMES) {
      const w = String(s.byOutcome[outcome] ?? 0).length;
      if (w > colWidths[outcome]) colWidths[outcome] = w;
    }
  }
  for (const outcome of RELIABILITY_OUTCOMES) {
    if (colWidths[outcome] < 1) colWidths[outcome] = 1;
  }

  const lines: string[] = [`Reliability (last ${total} record${total === 1 ? "" : "s"})`];
  for (const s of summaries) {
    const name = s.command.padEnd(nameWidth);
    const counts = RELIABILITY_OUTCOMES
      .map((o) => `${o} ${String(s.byOutcome[o] ?? 0).padStart(colWidths[o])}`)
      .join(" ");
    const avg = s.avgAttempts.toFixed(1);
    const last = s.lastRecordedAt ? s.lastRecordedAt.slice(0, 10) : "\u2014";
    lines.push(`${name}  ${counts}   avg-attempts ${avg}   last ${last}`);
  }
  return lines;
}
