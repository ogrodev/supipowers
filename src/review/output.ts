import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import invalidOutputRetryPrompt from "./prompts/invalid-output-retry.md" with { type: "text" };
import { runStructuredAgentSession } from "../quality/ai-session.js";
import { stripMarkdownCodeFence } from "../text.js";
import type { GateExecutionContext, ReviewOutput } from "../types.js";
import {
  ReviewOutputSchema,
  collectReviewValidationErrors,
  formatReviewValidationErrors,
} from "./types.js";
import { renderReviewTemplate } from "./template.js";

export interface StructuredParseResult<T> {
  output: T | null;
  error: string | null;
}

export interface OutputValidationRunOptions<T> {
  cwd: string;
  prompt: string;
  schema: string;
  parse: (raw: string) => StructuredParseResult<T>;
  model?: string;
  thinkingLevel?: string | null;
  timeoutMs?: number;
  maxAttempts?: number;
}

export type OutputValidationRunResult<T> =
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
    const errors = formatReviewValidationErrors(collectReviewValidationErrors(schema, parsed));
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

export function parseReviewOutput(raw: string): ReviewOutput | null {
  return parseStructuredOutput<ReviewOutput>(raw, ReviewOutputSchema).output;
}

export function explainReviewOutputFailure(raw: string): string | null {
  return parseStructuredOutput<ReviewOutput>(raw, ReviewOutputSchema).error;
}

export async function runWithOutputValidation<T>(
  createAgentSession: GateExecutionContext["createAgentSession"],
  options: OutputValidationRunOptions<T>,
): Promise<OutputValidationRunResult<T>> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const rawOutputs: string[] = [];
  let prompt = options.prompt;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await runStructuredAgentSession(createAgentSession, {
      cwd: options.cwd,
      prompt,
      model: options.model,
      thinkingLevel: options.thinkingLevel ?? null,
      timeoutMs: options.timeoutMs,
    });

    if (result.status !== "ok") {
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
      return {
        status: "ok",
        output: parsed.output,
        rawOutput: result.finalText,
        attempts: attempt,
      };
    }

    if (attempt === maxAttempts) {
      return {
        status: "blocked",
        error: parsed.error ?? "Agent output was invalid.",
        rawOutputs,
        attempts: attempt,
      };
    }

    prompt = renderReviewTemplate(invalidOutputRetryPrompt, {
      prompt: options.prompt,
      error: parsed.error ?? "Agent output was invalid.",
      previousOutput: truncateForPrompt(result.finalText),
      schema: options.schema,
    });
  }

  return {
    status: "blocked",
    error: "Output validation exhausted without producing a valid result.",
    rawOutputs,
    attempts: maxAttempts,
  };
}
