import { randomUUID } from "node:crypto";
import type {
  UltraPlanAttemptRecord,
  UltraPlanLaunchContext,
  UltraPlanSourceAgent,
} from "../../types.js";
import { isUltraPlanLaunchContext } from "../contracts.js";

/**
 * Slice-2 cross-hook correlation carrier.
 *
 * The runtime spec §cross-hook carrier requires that every slot-backed launch embed a launch
 * context into both structured metadata and the prompt/assignment text so later hooks can recover
 * the attempt identity even when the platform drops one carrier. This module owns minting,
 * injecting, and recovering that carrier. It is pure — no I/O.
 */

/** The metadata key the bridge uses to carry a structured launch context through platform hooks. */
export const LAUNCH_CONTEXT_METADATA_KEY = "ultraplanLaunchContext" as const;

/** The prompt marker key. The full line has the form `ULTRAPLAN_LAUNCH_CONTEXT=<json>`. */
export const LAUNCH_CONTEXT_PROMPT_MARKER = "ULTRAPLAN_LAUNCH_CONTEXT" as const;

export interface MintLaunchContextInput {
  attemptKey: string;
  sourceAgent: UltraPlanSourceAgent;
  nowIso: string;
  /**
   * When set, the minted launch context inherits the parent attempt's `attemptId` and
   * `attemptKey`. Slice 2 uses this so a nested sub-agent shares its parent's attempt identity
   * instead of minting a child attempt. Retries do NOT pass `inheritFrom` — they mint a fresh id.
   */
  inheritFrom?: UltraPlanLaunchContext | null;
}

/**
 * Mint a launch context. Pure.
 *
 * Identity rules (spec §cross-hook carrier, lines 454–460):
 * - A fresh attempt always mints a new `attemptId` — identity is never reused across retries.
 * - Nested sub-agent work under an active parent attempt inherits the parent's `attemptId` and
 *   `attemptKey` (slice 2 does not model child attempts).
 * - Same-launch replay of a not-yet-finalized launch reuses the current `attemptId` — that is
 *   the responsibility of the caller, who looks up the persisted active attempt first and passes
 *   it via `inheritFrom`.
 */
export function mintLaunchContext(input: MintLaunchContextInput): UltraPlanLaunchContext {
  const { attemptKey, sourceAgent, nowIso, inheritFrom } = input;

  if (inheritFrom && isUltraPlanLaunchContext(inheritFrom)) {
    return {
      attemptId: inheritFrom.attemptId,
      attemptKey: inheritFrom.attemptKey,
      sourceAgent,
      launchedAt: nowIso,
    };
  }

  return {
    attemptId: randomUUID(),
    attemptKey,
    sourceAgent,
    launchedAt: nowIso,
  };
}

/**
 * Inject the exact `ULTRAPLAN_LAUNCH_CONTEXT=<json>` line into a prompt/assignment string.
 *
 * Idempotent: if the prompt already contains a marker line for a context with the same payload,
 * a second injection does not duplicate it. Different payloads are detected by JSON equality.
 */
export function injectLaunchContextIntoPrompt(prompt: string, ctx: UltraPlanLaunchContext): string {
  const line = buildMarkerLine(ctx);
  if (prompt.includes(line)) {
    return prompt;
  }
  // If a different marker line already exists, replace it so the most recent intent wins.
  const existingLineRegex = new RegExp(`^${escapeRegExp(LAUNCH_CONTEXT_PROMPT_MARKER)}=.*$`, "m");
  if (existingLineRegex.test(prompt)) {
    return prompt.replace(existingLineRegex, line);
  }
  const separator = prompt.endsWith("\n") || prompt.length === 0 ? "" : "\n";
  return `${prompt}${separator}\n${line}`;
}

export interface RecoverLaunchContextInput {
  /** Structured platform metadata carried alongside the event. May be null. */
  metadata: Record<string, unknown> | null | undefined;
  /** Raw prompt / assignment / system prompt text that may carry the marker line. May be null. */
  prompt: string | null | undefined;
  /** The currently-persisted active attempt from the tracker, used as a last-resort. May be null. */
  persistedActiveAttempt: UltraPlanAttemptRecord | null | undefined;
}

/**
 * Recover a launch context from the available carriers.
 *
 * Priority (spec §cross-hook carrier, line 464):
 * 1. Structured metadata under the `ultraplanLaunchContext` key.
 * 2. `ULTRAPLAN_LAUNCH_CONTEXT=<json>` line inside the prompt/assignment text.
 * 3. The persisted active attempt record's own launch context, as a last-resort consistency check.
 * 4. Otherwise return null; the normalization layer surfaces this as a correlation failure.
 */
export function recoverLaunchContextFromEvent(input: RecoverLaunchContextInput): UltraPlanLaunchContext | null {
  const fromMetadata = readMetadataCarrier(input.metadata);
  if (fromMetadata) return fromMetadata;

  const fromPrompt = readPromptCarrier(input.prompt);
  if (fromPrompt) return fromPrompt;

  if (input.persistedActiveAttempt && isUltraPlanLaunchContext(input.persistedActiveAttempt.launchContext)) {
    return input.persistedActiveAttempt.launchContext;
  }
  return null;
}

// --- internal helpers ------------------------------------------------------

function readMetadataCarrier(metadata: RecoverLaunchContextInput["metadata"]): UltraPlanLaunchContext | null {
  if (!metadata || typeof metadata !== "object") return null;
  const candidate = (metadata as Record<string, unknown>)[LAUNCH_CONTEXT_METADATA_KEY];
  return isUltraPlanLaunchContext(candidate) ? candidate : null;
}

function readPromptCarrier(prompt: RecoverLaunchContextInput["prompt"]): UltraPlanLaunchContext | null {
  if (typeof prompt !== "string" || prompt.length === 0) return null;
  const lines = prompt.split(/\r?\n/);
  const prefix = `${LAUNCH_CONTEXT_PROMPT_MARKER}=`;
  for (const line of lines) {
    if (!line.startsWith(prefix)) continue;
    const json = line.slice(prefix.length);
    try {
      const parsed = JSON.parse(json);
      if (isUltraPlanLaunchContext(parsed)) return parsed;
    } catch {
      // ignore malformed JSON and continue scanning for a valid marker
    }
  }
  return null;
}

function buildMarkerLine(ctx: UltraPlanLaunchContext): string {
  return `${LAUNCH_CONTEXT_PROMPT_MARKER}=${JSON.stringify(ctx)}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
