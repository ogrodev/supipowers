import validationReviewPrompt from "./prompts/validation-review.md" with { type: "text" };
import type { GateExecutionContext, ReviewFinding, ReviewOutput, ReviewScope } from "../types.js";
import { runWithOutputValidation, type ReliabilityReporter } from "../ai/structured-output.js";
import { renderSchemaText } from "../ai/schema-text.js";
import { explainReviewOutputFailure, parseReviewOutput } from "./output.js";
import { renderTemplate } from "../ai/template.js";
import { ReviewOutputSchema } from "./types.js";

const REVIEW_OUTPUT_SCHEMA_TEXT = renderSchemaText(ReviewOutputSchema);

export interface ReviewValidationInput {
  cwd: string;
  scope: ReviewScope;
  findings: ReviewFinding[];
  createAgentSession: GateExecutionContext["createAgentSession"];
  model?: string;
  thinkingLevel?: string | null;
  timeoutMs?: number;
  validatorName?: string;
  now?: () => Date;
  reliability?: ReliabilityReporter;
}

export interface ReviewValidationResult {
  output: ReviewOutput;
  attempts: number;
  rawOutputs: string[];
}

function summarizeValidation(findings: ReviewFinding[]): string {
  const counts = findings.reduce(
    (summary, finding) => {
      const verdict = finding.validation?.verdict ?? "uncertain";
      summary[verdict] += 1;
      return summary;
    },
    { confirmed: 0, rejected: 0, uncertain: 0 },
  );

  return `Validation complete: ${counts.confirmed} confirmed, ${counts.rejected} rejected, ${counts.uncertain} uncertain.`;
}

function statusFromValidation(findings: ReviewFinding[]): ReviewOutput["status"] {
  const confirmed = findings.filter((finding) => finding.validation?.verdict === "confirmed").length;
  const uncertain = findings.filter((finding) => finding.validation?.verdict === "uncertain").length;

  if (confirmed > 0) {
    return "failed";
  }
  if (uncertain > 0) {
    return "blocked";
  }
  return "passed";
}

function applyValidationResults(
  findings: ReviewFinding[],
  candidate: ReviewFinding[],
  validatorName: string,
  validatedAt: string,
  fallbackReason: string,
): ReviewFinding[] {
  const byId = new Map(candidate.map((finding) => [finding.id, finding]));

  return findings.map((finding) => {
    const validated = byId.get(finding.id);
    const verdict = validated?.validation?.verdict ?? "uncertain";
    const reasoning = validated?.validation?.reasoning?.trim() || fallbackReason;

    return {
      ...finding,
      validation: {
        verdict,
        reasoning,
        validatedBy: validatorName,
        validatedAt,
      },
    };
  });
}

export function buildValidationPrompt(
  scope: ReviewScope,
  findings: ReviewFinding[],
  validatorName: string,
  validatedAt: string,
): string {
  return renderTemplate(validationReviewPrompt, {
    scope,
    findingsJson: JSON.stringify(findings, null, 2),
    validatorName,
    validatedAt,
    outputSchema: REVIEW_OUTPUT_SCHEMA_TEXT,
  });
}

export async function validateReviewFindings(input: ReviewValidationInput): Promise<ReviewValidationResult> {
  if (input.findings.length === 0) {
    return {
      output: {
        findings: [],
        summary: "No findings to validate.",
        status: "passed",
      },
      attempts: 0,
      rawOutputs: [],
    };
  }

  const validatorName = input.validatorName ?? "validator";
  const validatedAt = (input.now ?? (() => new Date()))().toISOString();
  const result = await runWithOutputValidation(input.createAgentSession, {
    cwd: input.cwd,
    prompt: buildValidationPrompt(input.scope, input.findings, validatorName, validatedAt),
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
    const findings = applyValidationResults(
      input.findings,
      [],
      validatorName,
      validatedAt,
      result.error,
    );

    return {
      output: {
        findings,
        summary: result.error,
        status: "blocked",
      },
      attempts: result.attempts,
      rawOutputs: result.rawOutputs,
    };
  }

  const findings = applyValidationResults(
    input.findings,
    result.output.findings,
    validatorName,
    validatedAt,
    "Validator did not return a verdict for this finding.",
  );

  return {
    output: {
      findings,
      summary: summarizeValidation(findings),
      status: statusFromValidation(findings),
    },
    attempts: result.attempts,
    rawOutputs: [result.rawOutput],
  };
}
