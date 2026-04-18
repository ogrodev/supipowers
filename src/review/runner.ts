import singleReviewPrompt from "./prompts/single-review.md" with { type: "text" };
import type { GateExecutionContext, ReviewLevel, ReviewOutput, ReviewScope } from "../types.js";
import { runWithOutputValidation, type ReliabilityReporter } from "../ai/structured-output.js";
import { renderSchemaText } from "../ai/schema-text.js";
import { explainReviewOutputFailure, parseReviewOutput } from "./output.js";
import { renderTemplate } from "../ai/template.js";
import { ReviewOutputSchema } from "./types.js";

const REVIEW_OUTPUT_SCHEMA_TEXT = renderSchemaText(ReviewOutputSchema);

export type SingleReviewLevel = Extract<ReviewLevel, "quick" | "deep">;

export interface SingleReviewRunnerInput {
  cwd: string;
  scope: ReviewScope;
  level: SingleReviewLevel;
  createAgentSession: GateExecutionContext["createAgentSession"];
  model?: string;
  thinkingLevel?: string | null;
  timeoutMs?: number;
  reliability?: ReliabilityReporter;
}

export interface SingleReviewRunResult {
  output: ReviewOutput;
  attempts: number;
  rawOutputs: string[];
}

function createFallbackFindingId(index: number): string {
  return `F${String(index + 1).padStart(3, "0")}`;
}

function normalizeReviewStatus(findingsCount: number, status: ReviewOutput["status"]): ReviewOutput["status"] {
  if (status === "blocked") {
    return "blocked";
  }
  if (findingsCount > 0) {
    return "failed";
  }
  return "passed";
}

export function normalizeReviewOutput(output: ReviewOutput): ReviewOutput {
  const seenIds = new Set<string>();
  const findings = output.findings.map((finding, index) => {
    let id = finding.id.trim();
    if (!id || seenIds.has(id)) {
      id = createFallbackFindingId(index);
    }
    seenIds.add(id);

    const normalizedFile = finding.file?.trim() ? finding.file.trim() : null;
    const normalizedLineStart = normalizedFile && finding.lineStart !== null ? finding.lineStart : null;
    const normalizedLineEnd =
      normalizedLineStart === null
        ? null
        : finding.lineEnd ?? normalizedLineStart;

    return {
      ...finding,
      id,
      title: finding.title.trim(),
      file: normalizedFile,
      lineStart: normalizedLineStart,
      lineEnd: normalizedLineEnd,
    };
  });

  return {
    ...output,
    findings,
    status: normalizeReviewStatus(findings.length, output.status),
  };
}

export function buildSingleReviewPrompt(scope: ReviewScope, level: SingleReviewLevel): string {
  return renderTemplate(singleReviewPrompt, {
    level,
    scope,
    isQuick: level === "quick",
    isDeep: level === "deep",
    outputSchema: REVIEW_OUTPUT_SCHEMA_TEXT,
  });
}

export async function runSingleReview(input: SingleReviewRunnerInput): Promise<SingleReviewRunResult> {
  const result = await runWithOutputValidation(input.createAgentSession, {
    cwd: input.cwd,
    prompt: buildSingleReviewPrompt(input.scope, input.level),
    schema: REVIEW_OUTPUT_SCHEMA_TEXT,
    parse(raw) {
      const output = parseReviewOutput(raw);
      return {
        output,
        error: output ? null : explainReviewOutputFailure(raw),
      };
    },
    model: input.model,
    thinkingLevel: input.thinkingLevel ?? null,
    timeoutMs: input.timeoutMs ?? 120_000,
    reliability: input.reliability,
  });

  if (result.status === "blocked") {
    return {
      output: {
        findings: [],
        summary: result.error,
        status: "blocked",
      },
      attempts: result.attempts,
      rawOutputs: result.rawOutputs,
    };
  }

  return {
    output: normalizeReviewOutput(result.output),
    attempts: result.attempts,
    rawOutputs: [result.rawOutput],
  };
}

export async function runQuickReview(
  input: Omit<SingleReviewRunnerInput, "level">,
): Promise<SingleReviewRunResult> {
  return runSingleReview({ ...input, level: "quick" });
}

export async function runDeepReview(
  input: Omit<SingleReviewRunnerInput, "level">,
): Promise<SingleReviewRunResult> {
  return runSingleReview({ ...input, level: "deep" });
}
