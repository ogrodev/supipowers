/**
 * Persistent slop queue.
 *
 * One JSONL file per project, keyed by violation id. The id is content-addressed (hash
 * over normalized `(file, range, kind, source-rule)`) so the same violation reported by
 * fallow and desloppify collapses to one entry — that's the deduplication strategy for the
 * `hybrid` backend.
 *
 * Operations:
 *  - `appendOpen(entry)` — atomic append-only write of a fresh `state: "open"` entry.
 *  - `resolve(id)` / `markWontfix(id)` — atomic rewrite of the file with the entry's state
 *    updated. (We rewrite rather than append because the queue is conceptually a set keyed
 *    by id, not a log.)
 *  - `next()` — returns the highest-severity, oldest-`open` entry (FIFO within severity).
 *  - `backlog(filter?)` — every open entry matching the filter.
 *  - `findById(id)` — single-entry lookup.
 *
 * Crash semantics: writes go through `temp + rename`. Readers tolerate one trailing partial
 * line (the storage layer already strips it).
 */

import { createHash } from "node:crypto";

import type { PlatformPaths } from "../../platform/types.js";
import type {
  HarnessSlopQueueEntry,
  HarnessSlopSource,
  HarnessSlopState,
  HarnessSlopViolationKind,
  UltraPlanStorageResult,
} from "../../types.js";
import {
  appendSlopQueueEntry,
  readSlopQueue,
  rewriteSlopQueue,
} from "../storage.js";

// ---------------------------------------------------------------------------
// Identity helpers
// ---------------------------------------------------------------------------

/**
 * Compute a stable, content-addressed id for a violation. Two backends reporting the same
 * `(file, range, kind, source-rule)` collapse to the same id, which lets the hybrid backend
 * deduplicate transparently.
 */
export function computeQueueEntryId(input: {
  kind: HarnessSlopViolationKind;
  file: string;
  range: HarnessSlopQueueEntry["range"];
  /** Optional rule id from the source backend (e.g. fallow rule slug). */
  ruleHint?: string;
}): string {
  const range = input.range
    ? `${input.range.startLine}-${input.range.endLine}`
    : "*";
  const fingerprint = `${input.kind}|${input.file}|${range}|${input.ruleHint ?? ""}`;
  return createHash("sha256").update(fingerprint).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Queue operations
// ---------------------------------------------------------------------------

export interface BacklogFilter {
  kind?: HarnessSlopViolationKind;
  source?: HarnessSlopSource;
  state?: HarnessSlopState;
  file?: string;
}

const SEVERITY_ORDER: Record<HarnessSlopQueueEntry["severity"], number> = {
  blocker: 0,
  warning: 1,
  info: 2,
};

/**
 * Append a fresh entry. Existing entries with the same id are NOT updated by this call —
 * use `resolve`/`markWontfix` for state transitions. Re-appending the same id is a no-op
 * at the consumer level (we deduplicate on read).
 */
export function appendOpen(
  paths: PlatformPaths,
  cwd: string,
  entry: Omit<HarnessSlopQueueEntry, "state"> & { state?: HarnessSlopState },
): UltraPlanStorageResult<string> {
  const filled: HarnessSlopQueueEntry = {
    ...entry,
    state: entry.state ?? "open",
  };
  return appendSlopQueueEntry(paths, cwd, filled);
}

/**
 * Read every entry. Duplicate ids are collapsed: the most recent record wins so resolve /
 * wontfix appended after the original takes precedence even when no rewrite happened.
 */
export function readAll(
  paths: PlatformPaths,
  cwd: string,
): UltraPlanStorageResult<HarnessSlopQueueEntry[]> {
  const result = readSlopQueue(paths, cwd);
  if (!result.ok) return result;
  const seen = new Map<string, HarnessSlopQueueEntry>();
  for (const entry of result.value) {
    seen.set(entry.id, entry);
  }
  return { ok: true, value: [...seen.values()] };
}

/** Pop the highest-severity, oldest open entry. Returns null when the queue is empty. */
export function next(
  paths: PlatformPaths,
  cwd: string,
): UltraPlanStorageResult<HarnessSlopQueueEntry | null> {
  const all = readAll(paths, cwd);
  if (!all.ok) return all;
  const open = all.value.filter((e) => e.state === "open");
  if (open.length === 0) return { ok: true, value: null };
  open.sort((a, b) => {
    const sev = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (sev !== 0) return sev;
    return a.ts.localeCompare(b.ts);
  });
  return { ok: true, value: open[0] };
}

/** Every open entry matching the filter. */
export function backlog(
  paths: PlatformPaths,
  cwd: string,
  filter: BacklogFilter = {},
): UltraPlanStorageResult<HarnessSlopQueueEntry[]> {
  const all = readAll(paths, cwd);
  if (!all.ok) return all;
  const targetState = filter.state ?? "open";
  return {
    ok: true,
    value: all.value.filter((e) => {
      if (e.state !== targetState) return false;
      if (filter.kind && e.kind !== filter.kind) return false;
      if (filter.source && e.source !== filter.source) return false;
      if (filter.file && e.file !== filter.file) return false;
      return true;
    }),
  };
}

export function findById(
  paths: PlatformPaths,
  cwd: string,
  id: string,
): UltraPlanStorageResult<HarnessSlopQueueEntry | null> {
  const all = readAll(paths, cwd);
  if (!all.ok) return all;
  return { ok: true, value: all.value.find((e) => e.id === id) ?? null };
}

function setState(
  paths: PlatformPaths,
  cwd: string,
  id: string,
  state: HarnessSlopState,
  resolvedAt?: string,
): UltraPlanStorageResult<HarnessSlopQueueEntry | null> {
  const all = readAll(paths, cwd);
  if (!all.ok) return all;
  let updated: HarnessSlopQueueEntry | null = null;
  const next: HarnessSlopQueueEntry[] = all.value.map((entry) => {
    if (entry.id !== id) return entry;
    updated = {
      ...entry,
      state,
      resolvedAt: resolvedAt ?? new Date().toISOString(),
    };
    return updated;
  });
  if (!updated) return { ok: true, value: null };
  const written = rewriteSlopQueue(paths, cwd, next);
  if (!written.ok) return written;
  return { ok: true, value: updated };
}

export function resolve(
  paths: PlatformPaths,
  cwd: string,
  id: string,
): UltraPlanStorageResult<HarnessSlopQueueEntry | null> {
  return setState(paths, cwd, id, "resolved");
}

export function markWontfix(
  paths: PlatformPaths,
  cwd: string,
  id: string,
): UltraPlanStorageResult<HarnessSlopQueueEntry | null> {
  return setState(paths, cwd, id, "wontfix");
}

/**
 * Clear resolved entries from the queue. Returns the number of entries removed. Used
 * during GC to keep the file from growing without bound.
 */
export function compact(
  paths: PlatformPaths,
  cwd: string,
): UltraPlanStorageResult<{ removed: number }> {
  const all = readAll(paths, cwd);
  if (!all.ok) return all;
  const before = all.value.length;
  const kept = all.value.filter((e) => e.state !== "resolved");
  const written = rewriteSlopQueue(paths, cwd, kept);
  if (!written.ok) return written;
  return { ok: true, value: { removed: before - kept.length } };
}
