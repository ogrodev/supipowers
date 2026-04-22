import { randomUUID } from "node:crypto";
import {
  ULTRAPLAN_AGENT_SLOT_NAMES,
  ULTRAPLAN_CURSOR_TARGETS,
  ULTRAPLAN_EXECUTION_PHASES,
  ULTRAPLAN_LEVELS,
  ULTRAPLAN_STACKS,
} from "../contracts.js";
import type {
  UltraPlanAttemptRecord,
  UltraPlanLaunchContext,
  UltraPlanSourceAgent,
} from "../../types.js";
import { isUltraPlanLaunchContext } from "../contracts.js";
import type { UltraPlanTargetHint } from "./normalize.js";

/**
 * Slice-2 cross-hook correlation carrier.
 *
 * The runtime spec §cross-hook carrier requires that every slot-backed launch embed a launch
 * context into both structured metadata and the prompt/assignment text so later hooks can recover
 * the attempt identity even when the platform drops one carrier. This module owns minting,
 * injecting, and recovering those carriers. It is pure — no I/O.
 */

/** The metadata key the bridge uses to carry a structured launch context through platform hooks. */
export const LAUNCH_CONTEXT_METADATA_KEY = "ultraplanLaunchContext" as const;
/** Prompt marker line form: `ULTRAPLAN_LAUNCH_CONTEXT=<json>`. */
export const LAUNCH_CONTEXT_PROMPT_MARKER = "ULTRAPLAN_LAUNCH_CONTEXT" as const;
/** Structured metadata key for the execution target hint carried alongside launch context. */
export const TARGET_HINT_METADATA_KEY = "ultraplanTargetHint" as const;
/** Prompt marker line form: `ULTRAPLAN_TARGET_HINT=<json>`. */
export const TARGET_HINT_PROMPT_MARKER = "ULTRAPLAN_TARGET_HINT" as const;

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
 * a second injection does not duplicate it. Different payloads replace the prior marker so the
 * latest intent wins.
 */
export function injectLaunchContextIntoPrompt(prompt: string, ctx: UltraPlanLaunchContext): string {
  return injectJsonCarrierIntoPrompt(prompt, LAUNCH_CONTEXT_PROMPT_MARKER, ctx);
}

/**
 * Inject the exact `ULTRAPLAN_TARGET_HINT=<json>` line into a prompt/assignment string.
 * Mirrors the launch-context carrier semantics so later hooks can recover the execution target
 * even when platform metadata is dropped.
 */
export function injectTargetHintIntoPrompt(prompt: string, hint: UltraPlanTargetHint): string {
  return injectJsonCarrierIntoPrompt(prompt, TARGET_HINT_PROMPT_MARKER, hint);
}

export interface RecoverLaunchContextInput {
  /** Structured platform metadata carried alongside the event. May be null. */
  metadata: Record<string, unknown> | null | undefined;
  /** Raw prompt / assignment / system prompt text that may carry the marker line. May be null. */
  prompt: string | null | undefined;
  /** The currently-persisted active attempt from the tracker, used as a last-resort. May be null. */
  persistedActiveAttempt: UltraPlanAttemptRecord | null | undefined;
}

/****
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

  const fromPrompt = recoverLaunchContextFromPrompt(input.prompt);
  if (fromPrompt) return fromPrompt;

  if (input.persistedActiveAttempt && isUltraPlanLaunchContext(input.persistedActiveAttempt.launchContext)) {
    return input.persistedActiveAttempt.launchContext;
  }
  return null;
}

export function recoverLaunchContextFromPrompt(prompt: string | null | undefined): UltraPlanLaunchContext | null {
  const candidate = readJsonPromptCarrier(prompt, LAUNCH_CONTEXT_PROMPT_MARKER);
  return isUltraPlanLaunchContext(candidate) ? candidate : null;
}

export function recoverTargetHintFromPrompt(prompt: string | null | undefined): UltraPlanTargetHint | null {
  const candidate = readJsonPromptCarrier(prompt, TARGET_HINT_PROMPT_MARKER);
  return isUltraPlanTargetHint(candidate) ? candidate : null;
}

// --- internal helpers ------------------------------------------------------

function readMetadataCarrier(metadata: RecoverLaunchContextInput["metadata"]): UltraPlanLaunchContext | null {
  if (!metadata || typeof metadata !== "object") return null;
  const candidate = (metadata as Record<string, unknown>)[LAUNCH_CONTEXT_METADATA_KEY];
  return isUltraPlanLaunchContext(candidate) ? candidate : null;
}

function injectJsonCarrierIntoPrompt(prompt: string, marker: string, payload: unknown): string {
  const line = buildMarkerLine(marker, payload);
  if (prompt.includes(line)) {
    return prompt;
  }

  const existingLineRegex = new RegExp(`^${escapeRegExp(marker)}=.*$`, "m");
  if (existingLineRegex.test(prompt)) {
    return prompt.replace(existingLineRegex, line);
  }

  const separator = prompt.endsWith("\n") || prompt.length === 0 ? "" : "\n";
  return `${prompt}${separator}\n${line}`;
}

function readJsonPromptCarrier(prompt: string | null | undefined, marker: string): unknown {
  if (typeof prompt !== "string" || prompt.length === 0) return null;
  const prefix = `${marker}=`;
  for (const line of prompt.split(/\r?\n/)) {
    if (!line.startsWith(prefix)) continue;
    try {
      return JSON.parse(line.slice(prefix.length));
    } catch {
      // Ignore malformed JSON and continue scanning for a valid marker.
    }
  }

  return null;
}

function buildMarkerLine(marker: string, payload: unknown): string {
  return `${marker}=${JSON.stringify(payload)}`;
}

function isUltraPlanTargetHint(value: unknown): value is UltraPlanTargetHint {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return isOptionalEnum(candidate.targetType, ULTRAPLAN_CURSOR_TARGETS)
    && isOptionalNullableEnum(candidate.stack, ULTRAPLAN_STACKS)
    && isOptionalNullableString(candidate.domainId)
    && isOptionalNullableEnum(candidate.level, ULTRAPLAN_LEVELS)
    && isOptionalNullableString(candidate.scenarioId)
    && isOptionalEnum(candidate.phase, ULTRAPLAN_EXECUTION_PHASES)
    && isOptionalNullableEnum(candidate.resolvedSlot, ULTRAPLAN_AGENT_SLOT_NAMES)
    && isOptionalEnum(candidate.actorKind, ["slot"] as const)
    && isOptionalEnum(candidate.sourceAgent, ["sub-agent"] as const);
}

function isOptionalEnum<TValue extends string>(
  value: unknown,
  allowed: readonly TValue[],
): value is TValue | undefined {
  return value === undefined || (typeof value === "string" && allowed.includes(value as TValue));
}

function isOptionalNullableEnum<TValue extends string>(
  value: unknown,
  allowed: readonly TValue[],
): value is TValue | null | undefined {
  return value === null || isOptionalEnum(value, allowed);
}

function isOptionalNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || (typeof value === "string" && value.length > 0);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
