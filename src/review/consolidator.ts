import type { ReviewFinding, ReviewOutput } from "../types.js";

const PRIORITY_ORDER: Record<ReviewFinding["priority"], number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

const SEVERITY_ORDER: Record<ReviewFinding["severity"], number> = {
  error: 0,
  warning: 1,
  info: 2,
};

function normalizeText(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4);
}

function tokenSimilarity(left: string, right: string): number {
  const leftTokens = normalizeText(left);
  const rightTokens = normalizeText(right);
  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return 0;
  }

  const leftSet = new Set(leftTokens);
  const rightSet = new Set(rightTokens);
  let shared = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) {
      shared += 1;
    }
  }

  return shared / Math.max(leftSet.size, rightSet.size);
}

function linesOverlap(left: ReviewFinding, right: ReviewFinding): boolean {
  if (!left.file || !right.file || left.file !== right.file) {
    return false;
  }
  if (left.lineStart === null || left.lineEnd === null || right.lineStart === null || right.lineEnd === null) {
    return false;
  }

  return left.lineStart <= right.lineEnd && right.lineStart <= left.lineEnd;
}

function areDuplicateFindings(left: ReviewFinding, right: ReviewFinding): boolean {
  if (!linesOverlap(left, right)) {
    return false;
  }

  const titleSimilarity = tokenSimilarity(left.title, right.title);
  const bodySimilarity = tokenSimilarity(left.body, right.body);
  return titleSimilarity >= 0.4 || bodySimilarity >= 0.35;
}

function comparePriority(left: ReviewFinding, right: ReviewFinding): number {
  const priorityDelta = PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority];
  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  const severityDelta = SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity];
  if (severityDelta !== 0) {
    return severityDelta;
  }

  return right.confidence - left.confidence;
}

function mergeAgentLabels(left: string | undefined, right: string | undefined): string | undefined {
  const labels = new Set(
    [left, right]
      .flatMap((value) => value?.split(",") ?? [])
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );

  if (labels.size === 0) {
    return undefined;
  }

  return [...labels].sort().join(",");
}

function mergeValidation(left: ReviewFinding, right: ReviewFinding): ReviewFinding["validation"] | undefined {
  const candidates = [left.validation, right.validation].filter((value) => value !== undefined);
  if (candidates.length === 0) {
    return undefined;
  }

  const ranking = { confirmed: 0, uncertain: 1, rejected: 2 } as const;
  candidates.sort((a, b) => ranking[a.verdict] - ranking[b.verdict]);
  return candidates[0];
}

function mergeFindings(left: ReviewFinding, right: ReviewFinding): ReviewFinding {
  const preferred = comparePriority(left, right) <= 0 ? left : right;
  const alternate = preferred === left ? right : left;

  return {
    ...preferred,
    confidence: Math.max(left.confidence, right.confidence),
    suggestion: preferred.suggestion ?? alternate.suggestion,
    agent: mergeAgentLabels(left.agent, right.agent),
    validation: mergeValidation(left, right),
  };
}

function sortFindings(findings: ReviewFinding[]): ReviewFinding[] {
  return [...findings].sort((left, right) => {
    const priority = comparePriority(left, right);
    if (priority !== 0) {
      return priority;
    }

    const fileLeft = left.file ?? "~";
    const fileRight = right.file ?? "~";
    const fileComparison = fileLeft.localeCompare(fileRight);
    if (fileComparison !== 0) {
      return fileComparison;
    }

    return (left.lineStart ?? Number.MAX_SAFE_INTEGER) - (right.lineStart ?? Number.MAX_SAFE_INTEGER);
  });
}

function statusFromFindings(findings: ReviewFinding[]): ReviewOutput["status"] {
  if (findings.length === 0) {
    return "passed";
  }

  const hasValidation = findings.some((finding) => finding.validation !== undefined);
  if (!hasValidation) {
    return "failed";
  }

  if (findings.some((finding) => finding.validation?.verdict === "confirmed")) {
    return "failed";
  }
  if (findings.some((finding) => finding.validation?.verdict === "uncertain")) {
    return "blocked";
  }
  return "passed";
}

export function consolidateReviewFindings(findings: ReviewFinding[]): ReviewFinding[] {
  const consolidated: ReviewFinding[] = [];

  for (const finding of sortFindings(findings)) {
    const index = consolidated.findIndex((candidate) => areDuplicateFindings(candidate, finding));
    if (index === -1) {
      consolidated.push(finding);
      continue;
    }

    consolidated[index] = mergeFindings(consolidated[index], finding);
  }

  return sortFindings(consolidated);
}

export function consolidateReviewOutputs(outputs: ReviewOutput[]): ReviewOutput {
  const allFindings = outputs.flatMap((output) => output.findings);
  const findings = consolidateReviewFindings(allFindings);

  return {
    findings,
    summary: `Consolidated ${allFindings.length} findings into ${findings.length} unique findings.`,
    status: statusFromFindings(findings),
  };
}
