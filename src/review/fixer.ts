import fixFindingsPrompt from "./prompts/fix-findings.md" with { type: "text" };
import type {
  GateExecutionContext,
  ReviewFinding,
  ReviewFixOutput,
  ReviewFixRecord,
  ReviewOutput,
  ReviewScope,
} from "../types.js";
import { parseStructuredOutput, runWithOutputValidation, type ReliabilityReporter } from "../ai/structured-output.js";
import { renderSchemaText } from "../ai/schema-text.js";
import { ReviewFixOutputSchema } from "./types.js";
import { renderTemplate } from "../ai/template.js";

const REVIEW_FIX_OUTPUT_SCHEMA_TEXT = renderSchemaText(ReviewFixOutputSchema);

export interface ReviewFixInput {
  cwd: string;
  scope: ReviewScope;
  findings: ReviewFinding[];
  createAgentSession: GateExecutionContext["createAgentSession"];
  model?: string;
  thinkingLevel?: string | null;
  timeoutMs?: number;
  reliability?: ReliabilityReporter;
}

export interface ReviewFixRunResult {
  output: ReviewFixOutput;
  attempts: number;
  rawOutputs: string[];
}

export interface ReviewOutputDelta {
  resolved: ReviewFinding[];
  remaining: ReviewFinding[];
  newFindings: ReviewFinding[];
}

function fingerprintFinding(finding: ReviewFinding): string {
  return [
    finding.file ?? "(unknown)",
    finding.lineStart ?? "?",
    finding.lineEnd ?? finding.lineStart ?? "?",
    finding.title.toLowerCase().replace(/\s+/g, " ").trim(),
  ].join("|");
}

function selectFixableFindings(findings: ReviewFinding[]): ReviewFinding[] {
  return findings.filter((finding) => finding.file !== null);
}

function createSkippedRecord(finding: ReviewFinding, summary: string): ReviewFixRecord {
  return {
    findingIds: [finding.id],
    file: finding.file,
    status: "skipped",
    summary,
  };
}

function summarizeFixRecords(records: ReviewFixRecord[]): string {
  const counts = records.reduce(
    (summary, record) => {
      summary[record.status] += 1;
      return summary;
    },
    { applied: 0, skipped: 0, failed: 0 },
  );

  return `Fix pass: ${counts.applied} applied, ${counts.skipped} skipped, ${counts.failed} failed.`;
}

function deriveFixStatus(records: ReviewFixRecord[], requestedCount: number): ReviewFixOutput["status"] {
  if (requestedCount === 0) {
    return "skipped";
  }

  const applied = records.filter((record) => record.status === "applied").length;
  const skipped = records.filter((record) => record.status === "skipped").length;
  const failed = records.filter((record) => record.status === "failed").length;

  if (applied === 0 && failed === 0 && skipped > 0) {
    return "skipped";
  }
  if (applied > 0 && skipped === 0 && failed === 0) {
    return "applied";
  }
  if (applied === 0 && failed > 0 && skipped === 0) {
    return "blocked";
  }
  return "partial";
}

function normalizeFixOutput(
  requestedFindings: ReviewFinding[],
  reported: ReviewFixOutput,
  carriedSkips: ReviewFixRecord[],
): ReviewFixOutput {
  const knownIds = new Set(requestedFindings.map((finding) => finding.id));
  const handledIds = new Set<string>();
  const fixes: ReviewFixRecord[] = [];

  for (const record of reported.fixes) {
    const findingIds = [...new Set(record.findingIds.filter((id) => knownIds.has(id) && !handledIds.has(id)))];
    if (findingIds.length === 0) {
      continue;
    }
    findingIds.forEach((id) => handledIds.add(id));
    fixes.push({
      ...record,
      findingIds,
    });
  }

  for (const finding of requestedFindings) {
    if (!handledIds.has(finding.id)) {
      fixes.push(createSkippedRecord(finding, "Fixer did not report handling this finding."));
    }
  }

  fixes.push(...carriedSkips);
  return {
    fixes,
    summary: reported.summary || summarizeFixRecords(fixes),
    status: reported.status === "blocked"
      ? "blocked"
      : deriveFixStatus(fixes, requestedFindings.length + carriedSkips.length),
  };
}

export function buildFixPrompt(scope: ReviewScope, findings: ReviewFinding[]): string {
  return renderTemplate(fixFindingsPrompt, {
    scope,
    findingsJson: JSON.stringify(findings, null, 2),
    fixOutputSchema: REVIEW_FIX_OUTPUT_SCHEMA_TEXT,
  });
}

export async function runAutoFix(input: ReviewFixInput): Promise<ReviewFixRunResult> {
  const skippedFindings = input.findings.filter((finding) => finding.file === null);
  const carriedSkips = skippedFindings.map((finding) =>
    createSkippedRecord(finding, "Skipped because the finding does not identify a concrete file to edit."),
  );
  const fixableFindings = selectFixableFindings(input.findings);

  if (fixableFindings.length === 0) {
    return {
      output: {
        fixes: carriedSkips,
        summary: carriedSkips.length > 0
          ? summarizeFixRecords(carriedSkips)
          : "No findings were eligible for automatic fixing.",
        status: "skipped",
      },
      attempts: 0,
      rawOutputs: [],
    };
  }

  const result = await runWithOutputValidation(input.createAgentSession, {
    cwd: input.cwd,
    prompt: buildFixPrompt(input.scope, fixableFindings),
    schema: REVIEW_FIX_OUTPUT_SCHEMA_TEXT,
    parse(raw) {
      return parseStructuredOutput<ReviewFixOutput>(raw, ReviewFixOutputSchema);
    },
    model: input.model,
    thinkingLevel: input.thinkingLevel ?? null,
    timeoutMs: input.timeoutMs ?? 180_000,
    reliability: input.reliability,
  });

  if (result.status === "blocked") {
    return {
      output: {
        fixes: [
          ...fixableFindings.map((finding) => createSkippedRecord(finding, result.error)),
          ...carriedSkips,
        ],
        summary: result.error,
        status: "blocked",
      },
      attempts: result.attempts,
      rawOutputs: result.rawOutputs,
    };
  }

  return {
    output: normalizeFixOutput(fixableFindings, result.output, carriedSkips),
    attempts: result.attempts,
    rawOutputs: [result.rawOutput],
  };
}

export function compareReviewOutputs(previous: ReviewOutput, next: ReviewOutput): ReviewOutputDelta {
  const previousMap = new Map(previous.findings.map((finding) => [fingerprintFinding(finding), finding]));
  const nextMap = new Map(next.findings.map((finding) => [fingerprintFinding(finding), finding]));

  const resolved: ReviewFinding[] = [];
  const remaining: ReviewFinding[] = [];
  const newFindings: ReviewFinding[] = [];

  for (const [fingerprint, finding] of previousMap) {
    if (nextMap.has(fingerprint)) {
      remaining.push(nextMap.get(fingerprint)!);
    } else {
      resolved.push(finding);
    }
  }

  for (const [fingerprint, finding] of nextMap) {
    if (!previousMap.has(fingerprint)) {
      newFindings.push(finding);
    }
  }

  return {
    resolved,
    remaining,
    newFindings,
  };
}
