/**
 * Anti-slop backend abstraction.
 *
 * Stages (Discover, Validate, GC) and runtime hooks (pre-edit dupe probe, post-session
 * sweep) consume slop scans through this interface. Concrete adapters wrap external CLIs
 * (`fallow`, `desloppify`) or implement supi-native scanning.
 *
 * Adapter contract:
 *  - `scan` returns the union of duplicate, dead-code, and other findings;
 *  - `dupes` is a focused near-duplicate scan (used by the pre-edit probe);
 *  - `deadCode` is a focused dead-export scan (used by post-session sweep);
 *  - `audit` runs the backend's full "everything that's wrong" pass (used by Validate);
 *  - `fix` applies the backend's safe auto-fixes (used by GC).
 *
 * All operations are advisory. Adapters MUST handle CLI-not-installed gracefully by
 * returning a `SlopBackendUnavailable` result (never throw) — callers route around the
 * unavailability without aborting the pipeline.
 */

import type { Platform } from "../../platform/types.js";
import type {
  HarnessAntiSlopBackend,
  HarnessSlopQueueEntry,
} from "../../types.js";

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/** A finding produced by a backend scan, before being normalized into a queue entry. */
export interface SlopFinding {
  kind: HarnessSlopQueueEntry["kind"];
  file: string;
  range: HarnessSlopQueueEntry["range"];
  severity: HarnessSlopQueueEntry["severity"];
  source: HarnessSlopQueueEntry["source"];
  message: string;
  remediation?: string;
  details?: Record<string, unknown>;
  /** Hint to the queue layer: when these findings should cluster, the same key is shared. */
  clusterKey?: string;
}

export interface SlopScanResult {
  ok: true;
  findings: SlopFinding[];
  durationMs: number;
  /** Free-form metadata (CLI version, stats, etc.). */
  details?: Record<string, unknown>;
}

export interface SlopBackendUnavailable {
  ok: false;
  reason: "not-installed" | "version-too-old" | "execution-failed" | "timeout" | "config-missing";
  message: string;
  /** When `execution-failed`, exit code and stderr for diagnostics. */
  exitCode?: number;
  stderr?: string;
}

export type SlopBackendResult = SlopScanResult | SlopBackendUnavailable;

// ---------------------------------------------------------------------------
// Options shapes
// ---------------------------------------------------------------------------

export interface ScanOptions {
  cwd: string;
  /** When set, restricts the scan to the given subtree (relative to cwd). */
  subtree?: string;
  /** When true, only scan files changed since HEAD. */
  changedSinceHead?: boolean;
  /** Hard timeout in ms; the adapter aborts and returns `timeout` past this. */
  timeoutMs?: number;
}

export interface DupesOptions extends ScanOptions {
  /** Minimum similarity threshold (0–1). */
  threshold?: number;
  /** Minimum token count below which results are filtered out. */
  minTokenCount?: number;
  /** When set, only scan files within this list (relative paths). */
  files?: string[];
  /** When set, the proposed content is staged into a shadow copy before scanning. */
  proposedWrite?: { file: string; content: string };
}

export type DeadCodeOptions = ScanOptions;
export type AuditOptions = ScanOptions;

export interface FixOptions extends ScanOptions {
  /** Specific entry ids to fix. */
  entryIds?: string[];
  /** When true, the adapter applies fixes; when false, it dry-runs. */
  apply: boolean;
}

export interface FixResult {
  ok: boolean;
  appliedIds: string[];
  failedIds: { id: string; reason: string }[];
  details?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

export interface SlopBackend {
  /** Identifier surfaced to score reports and queue entries. */
  readonly id: HarnessAntiSlopBackend;

  /** Quick availability check. Adapters cache the result for the lifetime of the process. */
  isAvailable(platform: Platform): Promise<boolean>;

  /** Full scan: duplicates + dead code + layer + other findings the backend supports. */
  scan(platform: Platform, opts: ScanOptions): Promise<SlopBackendResult>;

  /** Duplicate-only scan (focused for pre-edit probe). */
  dupes(platform: Platform, opts: DupesOptions): Promise<SlopBackendResult>;

  /** Dead-code-only scan (focused for post-session sweep). */
  deadCode(platform: Platform, opts: DeadCodeOptions): Promise<SlopBackendResult>;

  /** Full audit (used by Validate). */
  audit(platform: Platform, opts: AuditOptions): Promise<SlopBackendResult>;

  /** Apply mechanical auto-fixes. Returns the list of entry ids the adapter handled. */
  fix(platform: Platform, opts: FixOptions): Promise<FixResult>;
}

/**
 * Helper for adapters: clamp a value to a 0..1 range and return the default when undefined.
 */
export function clampThreshold(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
