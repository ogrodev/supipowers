import { createHash } from "node:crypto";
import type { ProcessorKey } from "./metrics-store.js";

export interface DedupRecord {
  contentHash: string;
  turnId: number;
  bytes: number;
  tsMonotonic: number;
}

export interface DedupState {
  records: Map<string, DedupRecord>;
  turnCounter: number;
}

interface ToolResultEventResult {
  content?: Array<{ type: string; text: string }>;
}

export interface DedupSubstitutionInput {
  result: ToolResultEventResult | undefined;
  processorKey: ProcessorKey;
  sourceHash: string | null;
  dedupState: DedupState;
  processedBytes: number;
}

export interface DedupSubstitutionResult {
  result: ToolResultEventResult | undefined;
  processorKey: ProcessorKey;
}

export const TTL_TURNS = 10;

export function createDedupState(): DedupState {
  return { records: new Map(), turnCounter: 0 };
}

export function combinedTextOf(
  content: Array<{ type: string; text?: string }> | undefined,
): string {
  if (!content) return "";
  const textEntries: string[] = [];
  for (const entry of content) {
    if (entry.type === "text" && entry.text) {
      textEntries.push(entry.text);
    }
  }
  return textEntries.join("\n");
}

function contentHashFor(result: ToolResultEventResult): string {
  return createHash("sha256").update(combinedTextOf(result.content)).digest("hex");
}

export function maybeSubstitute(input: DedupSubstitutionInput): DedupSubstitutionResult {
  const { result, processorKey, sourceHash, dedupState, processedBytes } = input;
  if (sourceHash === null || result === undefined) {
    return { result, processorKey };
  }

  const key = sourceHash;
  const contentHash = contentHashFor(result);
  const existing = dedupState.records.get(key);
  if (!existing || existing.contentHash !== contentHash) {
    dedupState.turnCounter += 1;
    dedupState.records.set(key, {
      contentHash,
      turnId: dedupState.turnCounter,
      bytes: processedBytes,
      tsMonotonic: dedupState.turnCounter,
    });
    return { result, processorKey };
  }

  if (dedupState.turnCounter - existing.tsMonotonic >= TTL_TURNS) {
    dedupState.turnCounter += 1;
    dedupState.records.set(key, {
      contentHash,
      turnId: dedupState.turnCounter,
      bytes: processedBytes,
      tsMonotonic: dedupState.turnCounter,
    });
    return { result, processorKey };
  }

  const placeholderText = `[…dedup: same as turn ${existing.turnId} (${existing.bytes} B); processor=${processorKey}]`;
  return {
    result: { content: [{ type: "text", text: placeholderText }] },
    processorKey: "dedup",
  };
}
