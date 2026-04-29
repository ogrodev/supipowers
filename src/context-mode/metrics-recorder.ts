// src/context-mode/metrics-recorder.ts
//
// Pure translation from a `tool_result` event into a `MetricRow`. No side
// effects: no DB calls, no network, no logging. Hooks call `toMetricRow`
// after `compressToolResult` decides what to return, then hand the row to
// the metrics store.
//
// Privacy contract: this module **must not** copy `event.input` (or any of
// its keys) into the returned row. Only the canonical tool name, the
// derived hash, the byte counts, and the (already-numeric) `contextUsage`
// fields flow through.

import { OMP_MINIMIZER_FOOTER_RE } from "./compressor.js";
import type { LayerKey, MetricRow, ProcessorKey } from "./metrics-store.js";
import { uniqueSourceHash } from "./source-hash.js";
import { canonicalToolName } from "./tool-name.js";

interface ToolResultEventLike {
  toolName: string;
  input: Record<string, unknown>;
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
  details?: unknown;
}

interface CompressedResult {
  content?: Array<{ type: string; text: string }>;
}

export interface ToolResultContextUsage {
  tokens: number | null;
  contextWindow: number | null;
  percent: number | null;
}

export interface ToMetricRowOpts {
  event: ToolResultEventLike;
  /** The compressor's verdict. `undefined` means "passed through, unchanged". */
  compressed: CompressedResult | undefined;
  sessionId: string;
  cwd: string;
  projectSlug: string;
  contextUsage: ToolResultContextUsage | null;
  ts: number;
  /** Defaults to "L2"; future layers override (e.g. L3 cache hits). */
  layer?: LayerKey;
  /** Processor chosen by the emission pipeline; omitted preserves legacy derivation. */
  processorKey?: ProcessorKey;
  /** Stable source hash computed by the hook; omitted preserves legacy derivation. */
  sourceHash?: string | null;
}

const PROCESSOR_BY_TOOL: Record<string, ProcessorKey> = {
  bash: "bash",
  read: "read",
  grep: "grep",
  find: "find",
};

function processorFor(canonicalTool: string): ProcessorKey {
  return PROCESSOR_BY_TOOL[canonicalTool] ?? null;
}

function bytesOfContent(
  content: Array<{ type: string; text?: string }> | undefined,
): number {
  if (!content) return 0;
  let total = 0;
  for (const entry of content) {
    if (entry.type === "text" && entry.text) {
      total += new TextEncoder().encode(entry.text).byteLength;
    }
  }
  return total;
}

function combinedText(
  content: Array<{ type: string; text?: string }> | undefined,
): string {
  if (!content) return "";
  let out = "";
  for (const entry of content) {
    if (entry.type === "text" && entry.text) {
      if (out.length > 0) out += "\n";
      out += entry.text;
    }
  }
  return out;
}

/**
 * Translate a tool_result event (plus the compressor's verdict) into a
 * MetricRow. Pure: no DB, no network, no logging. Returns a row even when
 * the recorder can't classify the tool (using `tool: "(system)"` and a null
 * processor), so every emission is observable.
 */
export function toMetricRow(opts: ToMetricRowOpts): MetricRow {
  const {
    event,
    compressed,
    sessionId,
    cwd,
    projectSlug,
    contextUsage,
    ts,
  } = opts;
  const explicitProcessorKey = opts.processorKey;
  const explicitSourceHash = opts.sourceHash;

  const canonical = canonicalToolName(event.toolName);
  const knownProcessor = processorFor(canonical);
  const isKnown = knownProcessor !== null;

  const before_bytes = bytesOfContent(event.content);
  const after_bytes = compressed?.content
    ? bytesOfContent(compressed.content)
    : before_bytes;

  let processor: ProcessorKey;
  if (explicitProcessorKey !== undefined) {
    processor = explicitProcessorKey;
  } else if (!isKnown) {
    processor = null;
  } else if (compressed === undefined) {
    // The compressor passed the result through. Distinguish three reasons:
    //   - OMP shellMinimizer already trimmed bash output
    //   - the result is below the compression threshold or scoped (read with
    //     offset/limit/sel), in which case we mark "passthrough"
    const text = combinedText(event.content);
    if (canonical === "bash" && OMP_MINIMIZER_FOOTER_RE.test(text)) {
      processor = "omp-minimizer";
    } else {
      processor = "passthrough";
    }
  } else {
    processor = knownProcessor;
  }

  const tool = isKnown ? canonical : "(system)";
  const sourceHash = explicitSourceHash !== undefined
    ? explicitSourceHash
    : isKnown
      ? uniqueSourceHash({
          tool: event.toolName,
          input: event.input,
          cwd,
          projectSlug,
        })
      : null;

  const layer: LayerKey = opts.layer ?? "L2";

  return {
    session_id: sessionId,
    ts,
    layer,
    tool,
    processor,
    before_bytes,
    after_bytes,
    cache_hit: 0,
    unique_source_hash: sourceHash,
    context_tokens: contextUsage?.tokens ?? null,
    context_window: contextUsage?.contextWindow ?? null,
    context_percent: contextUsage?.percent ?? null,
  };
}
