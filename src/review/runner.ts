import reviewOutputSchema from "./prompts/review-output-schema.md" with { type: "text" };
import singleReviewPrompt from "./prompts/single-review.md" with { type: "text" };
import type { GateExecutionContext, ReviewLevel, ReviewOutput, ReviewScope } from "../types.js";
import { explainReviewOutputFailure, parseReviewOutput, runWithOutputValidation } from "./output.js";
import { renderReviewTemplate } from "./template.js";

export type SingleReviewLevel = Extract<ReviewLevel, "quick" | "deep">;

export interface SingleReviewRunnerInput {
  cwd: string;
  scope: ReviewScope;
  level: SingleReviewLevel;
  createAgentSession: GateExecutionContext["createAgentSession"];
  model?: string;
  thinkingLevel?: string | null;
  timeoutMs?: number;
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
  return renderReviewTemplate(singleReviewPrompt, {
    level,
    scope,
    isQuick: level === "quick",
    isDeep: level === "deep",
    outputSchema: reviewOutputSchema.trim(),
  });
}

export async function runSingleReview(input: SingleReviewRunnerInput): Promise<SingleReviewRunResult> {
  const result = await runWithOutputValidation(input.createAgentSession, {
    cwd: input.cwd,
    prompt: buildSingleReviewPrompt(input.scope, input.level),
    schema: reviewOutputSchema.trim(),
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
