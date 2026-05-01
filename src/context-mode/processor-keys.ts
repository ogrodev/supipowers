// src/context-mode/processor-keys.ts
//
// Canonical mapping from a canonical native-tool name to the
// `ProcessorKey` used for both metric rows and compressor labels.
//
// Two consumers of this map exist today:
//   - the compressor labels its emitted result with the same processor key
//     that the metrics row will carry.
//   - the metrics recorder classifies the row when the compressor passed
//     a result through.
// Importing from one source prevents the two paths from drifting.
import type { ProcessorKey } from "./metrics-store.js";

/**
 * Canonical processor key for each native tool the metrics layer recognises.
 * Tools not listed here resolve to `null` (the recorder treats them as
 * unknown; the compressor short-circuits to no-op).
 */
export const NATIVE_TOOL_PROCESSOR_KEYS: Record<string, ProcessorKey> = {
  bash: "bash",
  read: "read",
  search: "search",
  find: "find",
};

/** Resolve the canonical processor key for a given canonical tool name. */
export function processorKeyForTool(canonicalTool: string): ProcessorKey {
  return NATIVE_TOOL_PROCESSOR_KEYS[canonicalTool] ?? null;
}
