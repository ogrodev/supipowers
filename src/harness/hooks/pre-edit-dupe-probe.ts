/**
 * Pre-edit duplication probe.
 *
 * Registered on `tool_call` for `write` / `edit` (and the legacy `Write` / `Edit`
 * casing). When the proposed write/edit's content matches an existing implementation
 * above the configured threshold, the hook returns `{ block: true, reason: ... }` so the
 * agent re-reads the duplicate path before retrying.
 *
 * Performance budget: ≤500 ms p95 on a 50k-LOC repo. We hard-fail the budget after
 * `timeoutMs` and emit a warning instead of blocking — the contract is "never block on
 * perf".
 *
 * The hook degrades gracefully when:
 *  - the harness marker is missing,
 *  - the configured backend isn't available,
 *  - the proposed write doesn't include enough tokens to meet `min_token_count`.
 */

import type { Platform } from "../../platform/types.js";
import type { HarnessHookConfig } from "../../types.js";
import {
  type SlopBackend,
} from "../anti_slop/backend.js";
import { computeQueueEntryId } from "../anti_slop/queue.js";
import { appendSlopQueueEntry } from "../storage.js";
import { getHarnessMarkerPath } from "../project-paths.js";
import * as fs from "node:fs";

export interface PreEditDupeProbeOptions {
  /** Backend adapter; pass null for supi-native (probe is then a no-op). */
  adapter: SlopBackend | null;
  /** Hook config. */
  config: HarnessHookConfig["pre_edit_dupe_probe"];
  /** Override the timeout (ms). Defaults to 500. */
  timeoutMs?: number;
}

interface ToolCallEvent {
  toolName?: string;
  input?: { path?: string; file?: string; content?: string; text?: string };
}

const TARGET_TOOLS = new Set(["write", "edit", "Write", "Edit"]);

function countWordTokens(text: string): number {
  return text.split(/\s+/).filter((t) => t.length > 0).length;
}

function extractFile(event: ToolCallEvent): string | null {
  return event.input?.path ?? event.input?.file ?? null;
}

function extractContent(event: ToolCallEvent): string | null {
  return event.input?.content ?? event.input?.text ?? null;
}

export interface ProbeResult {
  block: boolean;
  reason: string;
  duplicates: { path: string; line: number }[];
  durationMs: number;
}

/**
 * Run the probe synchronously-ish: we await the adapter but cap the await with
 * `timeoutMs`. Tests inject a fake adapter to assert on dispatch shape.
 */
export async function runPreEditProbe(input: {
  platform: Platform;
  cwd: string;
  candidateFile: string;
  proposedContent: string;
  adapter: SlopBackend;
  config: HarnessHookConfig["pre_edit_dupe_probe"];
  timeoutMs?: number;
}): Promise<ProbeResult> {
  const startedAt = Date.now();
  const tokens = countWordTokens(input.proposedContent);
  if (tokens < input.config.min_token_count) {
    return {
      block: false,
      reason: `proposed content has ${tokens} tokens (< min_token_count ${input.config.min_token_count})`,
      duplicates: [],
      durationMs: Date.now() - startedAt,
    };
  }

  const timeoutMs = input.timeoutMs ?? 500;
  const probePromise = input.adapter.dupes(input.platform, {
    cwd: input.cwd,
    threshold: input.config.threshold,
    minTokenCount: input.config.min_token_count,
    files: [input.candidateFile],
    proposedWrite: { file: input.candidateFile, content: input.proposedContent },
    timeoutMs,
  });

  let result;
  try {
    result = await Promise.race([
      probePromise,
      new Promise<{ ok: false; reason: "timeout"; message: string }>((resolve) => {
        setTimeout(
          () =>
            resolve({
              ok: false,
              reason: "timeout",
              message: `pre-edit probe exceeded ${timeoutMs} ms; skipping`,
            }),
          timeoutMs + 25,
        );
      }),
    ]);
  } catch (error) {
    return {
      block: false,
      reason: `probe threw: ${error instanceof Error ? error.message : String(error)}`,
      duplicates: [],
      durationMs: Date.now() - startedAt,
    };
  }

  if (!result.ok) {
    return {
      block: false,
      reason: `probe ${result.reason}: ${result.message}`,
      duplicates: [],
      durationMs: Date.now() - startedAt,
    };
  }

  const duplicates = result.findings
    .filter((f) => f.kind === "duplicate" && f.range !== null)
    .map((f) => ({ path: f.file, line: f.range?.startLine ?? 1 }));

  if (duplicates.length === 0) {
    return {
      block: false,
      reason: "no duplicate above threshold",
      duplicates: [],
      durationMs: Date.now() - startedAt,
    };
  }

  // Append to the queue so the user sees the violation even though we blocked.
  for (const finding of result.findings) {
    if (finding.kind !== "duplicate") continue;
    const id = computeQueueEntryId({
      kind: "duplicate",
      file: finding.file,
      range: finding.range,
      ruleHint: typeof finding.details?.rule === "string" ? finding.details.rule : "pre-edit-probe",
    });
    appendSlopQueueEntry(input.platform.paths, input.cwd, {
      id,
      kind: "duplicate",
      file: finding.file,
      range: finding.range,
      severity: finding.severity,
      source: finding.source,
      state: "open",
      message: finding.message,
      remediation: finding.remediation,
      ts: new Date().toISOString(),
      details: finding.details,
    });
  }

  const first = duplicates[0];
  return {
    block: true,
    reason: `Duplicate of ${first.path}:${first.line}; reuse instead of re-implementing`,
    duplicates,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Register the hook. Returns a teardown function. No-op when the adapter is null
 * (supi-native backend), the marker is missing, or the hook config disables it.
 */
export function registerPreEditDupeProbeHook(
  platform: Platform,
  options: PreEditDupeProbeOptions,
): () => void {
  if (!options.config.enabled || options.adapter === null) {
    return () => {};
  }
  let unregistered = false;
  const adapter = options.adapter;
  const config = options.config;
  const timeoutMs = options.timeoutMs ?? 500;

  const handler = async (event: ToolCallEvent, ctx: unknown) => {
    if (unregistered) return;
    if (!event.toolName || !TARGET_TOOLS.has(event.toolName)) return;
    const cwd = (ctx as { cwd?: string } | undefined)?.cwd ?? process.cwd();
    if (!fs.existsSync(getHarnessMarkerPath(platform.paths, cwd))) return;
    const candidateFile = extractFile(event);
    if (!candidateFile) return;
    const proposedContent = extractContent(event);
    if (!proposedContent) return;

    const result = await runPreEditProbe({
      platform,
      cwd,
      candidateFile,
      proposedContent,
      adapter,
      config,
      timeoutMs,
    });
    if (result.block) {
      return { block: true, reason: result.reason };
    }
    return undefined;
  };

  platform.on("tool_call", handler);

  return () => {
    unregistered = true;
  };
}
