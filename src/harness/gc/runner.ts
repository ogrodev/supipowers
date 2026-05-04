/**
 * GC subcommand driver.
 *
 * Drains the persistent slop queue and re-runs Validate. For each unresolved entry, the
 * GC classifies as **mechanical** (auto-fixable) or **judgmental** (reported only).
 * Mechanical fixes apply via the configured backend's `fix(apply: true)` and on success
 * the entry transitions to `resolved`.
 *
 * Concurrency is configurable (default 4). The runner is best-effort: a single failed
 * fixer never aborts the rest.
 */

import type { Platform, PlatformPaths } from "../../platform/types.js";
import type {
  HarnessAntiSlopBackend,
  HarnessSlopQueueEntry,
} from "../../types.js";
import type { SlopBackend } from "../anti_slop/backend.js";
import {
  backlog as readBacklog,
  resolve as resolveQueueEntry,
} from "../anti_slop/queue.js";

const DEFAULT_CONCURRENCY = 4;

const MECHANICAL_KINDS: ReadonlySet<HarnessSlopQueueEntry["kind"]> = new Set([
  "dead-code",
  "naming",
  "file-too-large",
]);

export interface GcInput {
  platform: Platform;
  paths: PlatformPaths;
  cwd: string;
  backend: HarnessAntiSlopBackend;
  /** Backend adapter, when the backend supports automated fixes. */
  adapter: SlopBackend | null;
  /** Concurrency for fix dispatch. Defaults to 4. */
  concurrency?: number;
  /** When true, fixes are applied; when false, GC dry-runs (reports only). */
  apply: boolean;
}

export interface GcReport {
  inspected: number;
  mechanicalAttempted: number;
  mechanicalResolved: number;
  judgmentalReported: number;
  failures: { id: string; reason: string }[];
  durationMs: number;
}

/**
 * Classify whether an entry is mechanical (eligible for auto-fix) or judgmental.
 */
export function isMechanical(entry: HarnessSlopQueueEntry): boolean {
  return MECHANICAL_KINDS.has(entry.kind);
}

/**
 * Run the GC drain. Pure dispatcher for tests; the real subcommand wraps this with
 * progress UI and report rendering.
 */
export async function runHarnessGc(input: GcInput): Promise<GcReport> {
  const startedAt = Date.now();
  const result: GcReport = {
    inspected: 0,
    mechanicalAttempted: 0,
    mechanicalResolved: 0,
    judgmentalReported: 0,
    failures: [],
    durationMs: 0,
  };

  const backlog = readBacklog(input.paths, input.cwd, { state: "open" });
  if (!backlog.ok) {
    result.durationMs = Date.now() - startedAt;
    result.failures.push({ id: "(read)", reason: backlog.error.message });
    return result;
  }

  const entries = backlog.value;
  result.inspected = entries.length;

  const mechanical = entries.filter(isMechanical);
  const judgmental = entries.filter((e) => !isMechanical(e));
  result.judgmentalReported = judgmental.length;

  if (mechanical.length === 0 || !input.adapter) {
    result.durationMs = Date.now() - startedAt;
    return result;
  }

  const concurrency = input.concurrency ?? DEFAULT_CONCURRENCY;
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < mechanical.length) {
      const idx = cursor;
      cursor += 1;
      if (idx >= mechanical.length) return;
      const entry = mechanical[idx];
      result.mechanicalAttempted += 1;
      const fix = await (input.adapter as SlopBackend).fix(input.platform, {
        cwd: input.cwd,
        entryIds: [entry.id],
        apply: input.apply,
      });
      if (fix.ok && fix.appliedIds.includes(entry.id)) {
        const resolved = resolveQueueEntry(input.paths, input.cwd, entry.id);
        if (resolved.ok && resolved.value) {
          result.mechanicalResolved += 1;
        } else {
          result.failures.push({
            id: entry.id,
            reason: !resolved.ok ? resolved.error.message : "entry already resolved or missing",
          });
        }
      } else {
        const failure = fix.failedIds.find((f) => f.id === entry.id);
        result.failures.push({
          id: entry.id,
          reason: failure?.reason ?? "fix did not include entry id",
        });
      }
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i += 1) workers.push(worker());
  await Promise.all(workers);

  result.durationMs = Date.now() - startedAt;
  return result;
}
