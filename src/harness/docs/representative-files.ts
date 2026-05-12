/**
 * Representative-file selection for the docs stage.
 *
 * Given a list of files in a layer, pick the top-N by LOC and produce a head-K slice of
 * each for the subagent's input bundle. Caps the total payload so even pathological
 * monorepo layers never blow the prompt budget.
 *
 * Deterministic ordering is non-negotiable — the source-hash composition depends on it.
 * Ordering is LOC-descending, then path-ascending as a tiebreaker.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { sha256 } from "./source-hash.js";

/**
 * Default top-N representative files to include. Matches the plan's Q7a contract.
 */
export const DEFAULT_REPRESENTATIVE_COUNT = 5;

/**
 * Default head-K LOC to sample per representative file. Matches the plan's Q7a contract.
 */
export const DEFAULT_REPRESENTATIVE_HEAD_LOC = 80;

/**
 * Hard cap on the total subagent input bundle in bytes. Keeps us well inside any
 * reasonable model context budget; representative-file output is the only growable
 * component.
 */
export const DEFAULT_BUNDLE_BYTES_CAP = 25_000;

export interface RepresentativeFileEntry {
  /** Forward-slashed path relative to the repo root. */
  path: string;
  /** Total LOC in the underlying file (used for ordering only). */
  loc: number;
  /** Head-K slice of the file body, with trailing "…\n" when the body was truncated. */
  sample: string;
  /** sha256 of the file's full contents at read time. */
  contentHash: string;
}

export interface SelectRepresentativeFilesInput {
  /** Repo root. All `files` paths are resolved relative to this. */
  cwd: string;
  /** Candidate files (forward-slashed, relative to `cwd`). */
  files: readonly string[];
  /** Max number of representative files to keep. */
  topN?: number;
  /** Max LOC to sample per file. */
  headLoc?: number;
  /** Total bundle byte cap; files past it are dropped in tail order. */
  bundleBytesCap?: number;
}

export interface SelectRepresentativeFilesResult {
  /** Selected representative files, sorted by LOC desc → path asc. */
  entries: RepresentativeFileEntry[];
  /** Files we considered but skipped because reading failed; useful for debugging. */
  unreadable: string[];
}

/**
 * Read every candidate file, sort by LOC desc, and emit a deterministic, byte-capped
 * representative sample list. Pure-ish: reads the filesystem but never writes.
 */
export function selectRepresentativeFiles(
  input: SelectRepresentativeFilesInput,
): SelectRepresentativeFilesResult {
  const topN = input.topN ?? DEFAULT_REPRESENTATIVE_COUNT;
  const headLoc = input.headLoc ?? DEFAULT_REPRESENTATIVE_HEAD_LOC;
  const bundleCap = input.bundleBytesCap ?? DEFAULT_BUNDLE_BYTES_CAP;

  type Stat = { path: string; loc: number; contents: string; contentHash: string };

  const stats: Stat[] = [];
  const unreadable: string[] = [];
  for (const rel of input.files) {
    const absolute = path.join(input.cwd, rel);
    let contents: string;
    try {
      contents = fs.readFileSync(absolute, "utf8");
    } catch {
      unreadable.push(rel);
      continue;
    }
    const loc = countLines(contents);
    stats.push({
      path: rel,
      loc,
      contents,
      contentHash: sha256(contents),
    });
  }

  stats.sort((a, b) => {
    if (a.loc !== b.loc) return b.loc - a.loc;
    return a.path.localeCompare(b.path);
  });

  const limited = stats.slice(0, topN);

  // Byte-cap pass: build samples and stop when the cumulative byte count would exceed
  // bundleBytesCap. We always emit the largest-LOC file (top of the list) even if it
  // alone exceeds the cap — the runner must know about it. Subsequent files yield to
  // the cap.
  const entries: RepresentativeFileEntry[] = [];
  let used = 0;
  for (let i = 0; i < limited.length; i += 1) {
    const stat = limited[i];
    const sample = headSlice(stat.contents, headLoc);
    const cost = Buffer.byteLength(sample, "utf8");
    if (i > 0 && used + cost > bundleCap) break;
    used += cost;
    entries.push({
      path: stat.path,
      loc: stat.loc,
      sample,
      contentHash: stat.contentHash,
    });
  }

  return { entries, unreadable };
}

function countLines(contents: string): number {
  if (contents.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < contents.length; i += 1) {
    if (contents.charCodeAt(i) === 10 /* \n */) count += 1;
  }
  // A trailing newline implies the last "line" is empty; subtract one to match `wc -l`-ish
  // semantics callers expect.
  if (contents.charCodeAt(contents.length - 1) === 10) count -= 1;
  return count;
}

function headSlice(contents: string, headLoc: number): string {
  if (headLoc <= 0) return "";
  let consumed = 0;
  let cursor = 0;
  for (let i = 0; i < contents.length; i += 1) {
    if (contents.charCodeAt(i) === 10 /* \n */) {
      consumed += 1;
      if (consumed >= headLoc) {
        cursor = i + 1;
        break;
      }
    }
    cursor = i + 1;
  }
  if (cursor >= contents.length) return contents;
  return `${contents.slice(0, cursor)}…\n`;
}

/**
 * Render the subagent input bundle's representative-files block.
 *
 * Format mirrors the plan's Q7a contract:
 *   --- src/path/a.ts ---
 *   <sample>
 *   --- src/path/b.ts ---
 *   ...
 */
export function renderRepresentativeBlock(entries: readonly RepresentativeFileEntry[]): string {
  if (entries.length === 0) return "(no representative files)";
  const out: string[] = [];
  for (const entry of entries) {
    out.push(`--- ${entry.path} ---`);
    out.push(entry.sample.endsWith("\n") ? entry.sample.slice(0, -1) : entry.sample);
  }
  return out.join("\n");
}
