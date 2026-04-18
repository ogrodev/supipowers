// src/ai/structured-output.ts
//
// Canonical schema-backed AI output path. Every AI-heavy workflow (review,
// planning, commit, docs-drift, AI review gate, fix-pr, release) must flow
// through this module for:
//   - final assistant message extraction (via ./final-message.ts)
//   - JSON-fence stripping + schema-checked parsing
//   - retry with a validator-feedback prompt until maxAttempts exhausts
//   - explicit blocked result when parsing never succeeds
//
// One canonical retry template lives in `./prompts/invalid-output-retry.md`.
// One canonical renderer lives in `./template.ts`. Neither has a review-
// specific name any more.

import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import invalidOutputRetryPrompt from "./prompts/invalid-output-retry.md" with { type: "text" };
import { runStructuredAgentSession } from "./final-message.js";
import { renderTemplate } from "./template.js";
import { stripMarkdownCodeFence } from "../text.js";
import type { GateExecutionContext, ReliabilityOutcome, ValidationError } from "../types.js";
import type { PlatformPaths } from "../platform/types.js";
import { appendReliabilityRecord } from "../storage/reliability-metrics.js";

export interface StructuredParseResult<T> {
  output: T | null;
  error: string | null;
}

export interface StructuredOutputRunOptions<T> {
  cwd: string;
  prompt: string;
  /**
   * Prompt-visible schema text, produced by schema-text.ts. Injected into
   * the retry prompt so the model can self-correct on invalid output.
   */
  schema: string;
  /**
   * Parse raw model text into T. Implementations typically delegate to
   * `parseStructuredOutput(raw, SomeSchema)`.
   */
  parse: (raw: string) => StructuredParseResult<T>;
  model?: string;
  thinkingLevel?: string | null;
  timeoutMs?: number;
  /** Default: 3. Clamped to >=1 at runtime. */
  maxAttempts?: number;
  /**
   * Optional reliability reporter. When supplied, the runner appends one
   * ReliabilityRecord per final outcome (ok / retry-exhausted / agent-error)
   * to the cwd-local reliability events log. No-op when omitted.
   */
  reliability?: ReliabilityReporter;
}

/**
 * Describes how to report the outcome of a runWithOutputValidation call to
 * the per-cwd reliability log. Every AI-heavy production call site supplies
 * one of these; the helper itself emits exactly one record per final outcome.
 *
 * Emission is best-effort: failures are swallowed (metrics must never crash
 * the workflow they observe).
 */
export interface ReliabilityReporter {
  paths: PlatformPaths;
  cwd: string;
  /** Logical command name (e.g. "plan", "commit", "review"). */
  command: string;
  /** Optional sub-operation (e.g. "commit-plan", "note-polish"). */
  operation?: string;
}

export type StructuredOutputResult<T> =
  | {
      status: "ok";
      output: T;
      rawOutput: string;
      attempts: number;
    }
  | {
      status: "blocked";
      error: string;
      rawOutputs: string[];
      attempts: number;
    };

function truncateForPrompt(text: string, maxLength = 1200): string {
  const normalized = text.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function normalizeErrorPath(path: string): string {
  return path.replace(/^\//, "").replace(/\//g, ".") || "(root)";
}

/**
 * Collect schema validation errors for a TypeBox schema in a stable
 * {path, message} shape. Used by parseStructuredOutput and by any code that
 * needs to format schema-check failures for humans or prompts.
 */
export function collectValidationErrors(schema: TSchema, data: unknown): ValidationError[] {
  return [...Value.Errors(schema, data)].map((error) => ({
    path: normalizeErrorPath(error.path),
    message: error.message,
  }));
}

/**
 * Render validation errors as `path: message` lines.
 */
export function formatValidationErrors(errors: ValidationError[]): string[] {
  return errors.map((error) => `${error.path}: ${error.message}`);
}

/**
 * Strip markdown fences, JSON-parse, and schema-check against a TypeBox.
 * Returns {output: T, error: null} on success; {output: null, error: string}
 * on failure with a human-readable error suitable for retry prompts.
 */
export function parseStructuredOutput<T>(raw: string, schema: TSchema): StructuredParseResult<T> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(stripMarkdownCodeFence(raw));
  } catch (error) {
    return {
      output: null,
      error: error instanceof Error ? `Invalid JSON: ${error.message}` : "Invalid JSON.",
    };
  }

  if (!Value.Check(schema, parsed)) {
    const errors = formatValidationErrors(collectValidationErrors(schema, parsed));
    return {
      output: null,
      error: errors.length > 0 ? errors.join("; ") : "Output does not match the required schema.",
    };
  }

  return {
    output: parsed as T,
    error: null,
  };
}

/**
 * Run a schema-backed AI session with retry-on-invalid-output. On every
 * retry, the original prompt is wrapped with the invalid-output-retry
 * template so the model sees the validation error and its previous output.
 *
 * Returns `status: "ok"` on first successful schema-valid parse. Returns
 * `status: "blocked"` when maxAttempts exhausts, when the underlying agent
 * session errors, or when no final assistant text is produced.
 */
export async function runWithOutputValidation<T>(
  createAgentSession: GateExecutionContext["createAgentSession"],
  options: StructuredOutputRunOptions<T>,
): Promise<StructuredOutputResult<T>> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const rawOutputs: string[] = [];
  let prompt = options.prompt;
  let attempt = 0;

  try {
    for (attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const result = await runStructuredAgentSession(createAgentSession, {
        cwd: options.cwd,
        prompt,
        model: options.model,
        thinkingLevel: options.thinkingLevel ?? null,
        timeoutMs: options.timeoutMs,
      });

      if (result.status !== "ok") {
        emitReliabilityOutcome(options.reliability, "agent-error", attempt, result.error);
        return {
          status: "blocked",
          error: result.error,
          rawOutputs,
          attempts: attempt,
        };
      }

      rawOutputs.push(result.finalText);
      const parsed = options.parse(result.finalText);
      if (parsed.output) {
        emitReliabilityOutcome(options.reliability, "ok", attempt);
        return {
          status: "ok",
          output: parsed.output,
          rawOutput: result.finalText,
          attempts: attempt,
        };
      }

      if (attempt === maxAttempts) {
        const reason = parsed.error ?? "Agent output was invalid.";
        emitReliabilityOutcome(options.reliability, "retry-exhausted", attempt, reason);
        return {
          status: "blocked",
          error: reason,
          rawOutputs,
          attempts: attempt,
        };
      }

      prompt = renderTemplate(invalidOutputRetryPrompt, {
        prompt: options.prompt,
        error: parsed.error ?? "Agent output was invalid.",
        previousOutput: truncateForPrompt(result.finalText),
        schema: options.schema,
      });
    }
  } catch (error) {
    // createAgentSession (or anything else) threw before completing a final
    // outcome — record as agent-error and re-raise so callers keep their
    // existing error semantics.
    const reason = error instanceof Error ? error.message : String(error);
    emitReliabilityOutcome(
      options.reliability,
      "agent-error",
      Math.max(1, attempt),
      reason,
    );
    throw error;
  }

  // Fallthrough: loop exhausted without a final outcome. Treat as retry-
  // exhausted for the record, and return blocked so callers see the same
  // shape they used to.
  emitReliabilityOutcome(
    options.reliability,
    "retry-exhausted",
    maxAttempts,
    "Output validation exhausted without producing a valid result.",
  );
  return {
    status: "blocked",
    error: "Output validation exhausted without producing a valid result.",
    rawOutputs,
    attempts: maxAttempts,
  };
}

function emitReliabilityOutcome(
  reporter: ReliabilityReporter | undefined,
  outcome: ReliabilityOutcome,
  attempts: number,
  reason?: string,
): void {
  if (!reporter) return;
  try {
    appendReliabilityRecord(reporter.paths, reporter.cwd, {
      ts: new Date().toISOString(),
      command: reporter.command,
      operation: reporter.operation,
      outcome,
      attempts,
      reason,
      cwd: reporter.cwd,
    });
  } catch {
    // Defensive: appendReliabilityRecord already swallows its own errors,
    // but we double-guard so a reporter misconfiguration never crashes the
    // workflow it observes.
  }
}
