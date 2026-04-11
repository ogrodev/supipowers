import reviewOutputSchema from "./prompts/review-output-schema.md" with { type: "text" };
import validationReviewPrompt from "./prompts/validation-review.md" with { type: "text" };
import type { GateExecutionContext, ReviewFinding, ReviewOutput, ReviewScope } from "../types.js";
import { explainReviewOutputFailure, parseReviewOutput, runWithOutputValidation } from "./output.js";
import { renderReviewTemplate } from "./template.js";

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
  return renderReviewTemplate(validationReviewPrompt, {
    scope,
    findingsJson: JSON.stringify(findings, null, 2),
    validatorName,
    validatedAt,
    outputSchema: reviewOutputSchema.trim(),
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
