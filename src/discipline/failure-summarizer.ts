// src/discipline/failure-summarizer.ts
//
// Offline analyzer that walks stored reliability records and persisted
// session artifacts, classifies each failure via the failure taxonomy,
// and produces a compact deterministic report.
//
// The summarizer is pure: given the same input records it produces the
// same report. Every data source is optional — callers pass what they
// have, the summarizer copes with partial inputs.
//
// Phase 8 exit gate: recurring failures are aggregated so the next
// hardening target is evidence-driven, not anecdotal.

import type { PlatformPaths } from "../platform/types.js";
import type { ReliabilityRecord } from "../types.js";
import { readReliabilityRecords } from "../storage/reliability-metrics.js";
import {
  FAILURE_CLASSES,
  classifyFailure,
  describeFailureClass,
  type FailureClass,
} from "./failure-taxonomy.js";

export interface FailureOccurrence {
  /** Timestamp of the underlying event. */
  ts: string;
  /** Command that produced the failure. */
  command: string;
  /** Specific operation (e.g. "commit-plan"), when known. */
  operation?: string;
  /** All classes that fired for this occurrence. */
  classes: FailureClass[];
  /** Truthful reason from the record. */
  reason?: string;
}

export interface FailureClassAggregate {
  class: FailureClass;
  description: string;
  /** Total occurrences of this class in the input. */
  count: number;
  /** Count per command, sorted alphabetically. */
  byCommand: Array<{ command: string; count: number }>;
  /** Up to `exampleCount` representative records for review. */
  examples: FailureOccurrence[];
}

export interface FailureSummary {
  /** Total non-ok records considered. */
  totalFailures: number;
  /** Failure classes that fired at least once, sorted by taxonomy order. */
  aggregates: FailureClassAggregate[];
  /** Non-ok records that did NOT match any taxonomy class. */
  unclassified: FailureOccurrence[];
}

export interface SummarizeOptions {
  /** Number of example occurrences per class. Default 3. */
  exampleCount?: number;
}

function isFailureRecord(record: ReliabilityRecord): boolean {
  return record.outcome !== "ok";
}

function classifyRecord(record: ReliabilityRecord): FailureOccurrence {
  const classes = classifyFailure({
    outcome: record.outcome,
    reason: record.reason,
    // attempts used by unproductive-retry rule
    attempts: record.attempts,
  } as any);
  return {
    ts: record.ts,
    command: record.command,
    operation: record.operation,
    classes,
    reason: record.reason,
  };
}

function aggregate(
  occurrences: FailureOccurrence[],
  exampleCount: number,
): FailureClassAggregate[] {
  const map = new Map<FailureClass, FailureOccurrence[]>();
  for (const occ of occurrences) {
    for (const cls of occ.classes) {
      const list = map.get(cls) ?? [];
      list.push(occ);
      map.set(cls, list);
    }
  }

  const aggregates: FailureClassAggregate[] = [];
  for (const cls of FAILURE_CLASSES) {
    const list = map.get(cls);
    if (!list || list.length === 0) continue;
    const byCommandMap = new Map<string, number>();
    for (const occ of list) {
      byCommandMap.set(occ.command, (byCommandMap.get(occ.command) ?? 0) + 1);
    }
    const byCommand = [...byCommandMap.entries()]
      .map(([command, count]) => ({ command, count }))
      .sort((a, b) => a.command.localeCompare(b.command));

    aggregates.push({
      class: cls,
      description: describeFailureClass(cls),
      count: list.length,
      byCommand,
      examples: list.slice(0, Math.max(0, exampleCount)),
    });
  }

  return aggregates;
}

/**
 * Summarize an arbitrary list of reliability records. Pure — no filesystem.
 * Callers can combine records from multiple sources before summarizing.
 */
export function summarizeFailures(
  records: ReliabilityRecord[],
  options: SummarizeOptions = {},
): FailureSummary {
  const exampleCount = options.exampleCount ?? 3;
  const failures = records.filter(isFailureRecord).map(classifyRecord);

  const classified = failures.filter((f) => f.classes.length > 0);
  const unclassified = failures.filter((f) => f.classes.length === 0);

  return {
    totalFailures: failures.length,
    aggregates: aggregate(classified, exampleCount),
    unclassified,
  };
}

/**
 * Convenience: load records from the per-cwd reliability store and
 * summarize. Empty store produces an empty summary (no crashes).
 */
export function summarizeLocalFailures(
  paths: PlatformPaths,
  cwd: string,
  options: SummarizeOptions = {},
): FailureSummary {
  return summarizeFailures(readReliabilityRecords(paths, cwd), options);
}

/**
 * Format a summary as readable lines. `[]` when there are no failures so
 * callers can branch on length without a special case.
 */
export function formatFailureSummary(summary: FailureSummary): string[] {
  if (summary.totalFailures === 0) return [];

  const lines: string[] = [`Failure summary: ${summary.totalFailures} non-ok record(s)`];
  for (const agg of summary.aggregates) {
    lines.push(`  [${agg.class}] ${agg.description} \u2014 ${agg.count} occurrence(s)`);
    for (const per of agg.byCommand) {
      lines.push(`    \u00b7 ${per.command}: ${per.count}`);
    }
  }
  if (summary.unclassified.length > 0) {
    lines.push(`  [unclassified] ${summary.unclassified.length} record(s) did not match any taxonomy class`);
  }
  return lines;
}
