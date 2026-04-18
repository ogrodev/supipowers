// src/fix-pr/assessment.ts
//
// Runs the structured per-comment assessment for fix-pr. One schema-backed
// AI call per cluster; the validated FixPrAssessmentBatch is the single
// source of truth for downstream work batches.

import type { Platform, PlatformPaths } from "../platform/types.js";
import {
  parseStructuredOutput,
  runWithOutputValidation,
  type StructuredOutputResult,
} from "../ai/structured-output.js";
import { renderSchemaText } from "../ai/schema-text.js";
import {
  FixPrAssessmentBatchSchema,
  type FixPrAssessmentBatch,
  type FixPrWorkBatch,
} from "./contracts.js";
import type { PrComment } from "./types.js";

export interface RunFixPrAssessmentInput {
  createAgentSession: Platform["createAgentSession"];
  paths?: PlatformPaths;
  cwd: string;
  comments: readonly PrComment[];
  repo: string;
  prNumber: number;
  selectedTargetLabel: string;
  model?: string;
  thinkingLevel?: string | null;
  maxAttempts?: number;
}

interface BuildAssessmentPromptArgs {
  schemaText: string;
  comments: readonly PrComment[];
  repo: string;
  prNumber: number;
  selectedTargetLabel: string;
}

function buildAssessmentPrompt(args: BuildAssessmentPromptArgs): string {
  const commentsJsonl = args.comments.map((c) => JSON.stringify(c)).join("\n");
  return [
    "# Fix-PR Assessment",
    "",
    `You are assessing PR review comments on \`${args.repo}\` PR #${args.prNumber} for target: ${args.selectedTargetLabel}.`,
    "",
    "For each comment, emit one assessment object with:",
    `- verdict: "apply" (reviewer is right, fix it), "reject" (reviewer is wrong, explain), "investigate" (needs more info before deciding)`,
    "- rationale: 1-3 sentences of technical reasoning grounded in the actual code",
    `- affectedFiles: files that would be edited if verdict is "apply"; empty array otherwise`,
    "- rippleEffects: downstream impacts (callers, tests, docs); empty array if none",
    "- verificationPlan: how to confirm the fix is correct (which tests to run, behaviour to check)",
    "",
    "Rules:",
    "- Read the referenced code before assigning a verdict.",
    "- Do not perform any code edits. This is a pure assessment pass.",
    "- One assessment per comment. `commentId` ties back to the PR comment id.",
    "",
    "Comments (JSONL, one per line):",
    "```jsonl",
    commentsJsonl,
    "```",
    "",
    "Respond with a JSON object that matches this TypeScript shape exactly:",
    "",
    "```ts",
    args.schemaText,
    "```",
    "",
    "Respond with only the JSON object. You may wrap it in a ```json fence.",
  ].join("\n");
}

/**
 * Run a schema-backed assessment over a cluster of PR comments.
 *
 * Empty clusters short-circuit with `{ assessments: [] }` without calling
 * the AI, so a no-op target can be persisted and grouped without cost.
 */
export async function runFixPrAssessment(
  input: RunFixPrAssessmentInput,
): Promise<StructuredOutputResult<FixPrAssessmentBatch>> {
  if (input.comments.length === 0) {
    return {
      status: "ok",
      output: { assessments: [] },
      rawOutput: "",
      attempts: 0,
    };
  }

  const schemaText = renderSchemaText(FixPrAssessmentBatchSchema);
  const prompt = buildAssessmentPrompt({
    schemaText,
    comments: input.comments,
    repo: input.repo,
    prNumber: input.prNumber,
    selectedTargetLabel: input.selectedTargetLabel,
  });

  return runWithOutputValidation<FixPrAssessmentBatch>(
    input.createAgentSession as any,
    {
      cwd: input.cwd,
      prompt,
      schema: schemaText,
      parse: (raw) =>
        parseStructuredOutput<FixPrAssessmentBatch>(raw, FixPrAssessmentBatchSchema),
      model: input.model,
      thinkingLevel: input.thinkingLevel ?? null,
      maxAttempts: input.maxAttempts,
      reliability: input.paths
        ? { paths: input.paths, cwd: input.cwd, command: "fix-pr", operation: "assessment" }
        : undefined,
    },
  );
}

/**
 * Deterministic grouping rule:
 *
 * 1. Only `apply` verdicts produce work batches; `reject` and `investigate`
 *    are preserved in the artifact but excluded here.
 * 2. Two `apply` assessments go in the same batch when their `affectedFiles`
 *    sets share at least one path (connected components over the file graph).
 * 3. An `apply` assessment with empty `affectedFiles` is its own singleton
 *    batch — nothing to merge against.
 * 4. Within a batch, commentIds are sorted ascending; batches are ordered by
 *    their smallest commentId. Batch ids are `batch-<minCommentId>`.
 *
 * The rule depends only on the validated artifact, so batching is a pure
 * function of `FixPrAssessmentBatch`.
 */
export function groupAssessmentsIntoBatches(
  batch: FixPrAssessmentBatch,
): FixPrWorkBatch[] {
  const applies = batch.assessments.filter((a) => a.verdict === "apply");
  if (applies.length === 0) return [];

  const parent = applies.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    // path compression
    let cur = i;
    while (parent[cur] !== root) {
      const next = parent[cur];
      parent[cur] = root;
      cur = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  const fileOwner = new Map<string, number>();
  for (let i = 0; i < applies.length; i += 1) {
    for (const file of applies[i].affectedFiles) {
      const existing = fileOwner.get(file);
      if (existing === undefined) {
        fileOwner.set(file, i);
      } else {
        union(existing, i);
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < applies.length; i += 1) {
    const root = find(i);
    const list = groups.get(root);
    if (list) list.push(i);
    else groups.set(root, [i]);
  }

  const result: FixPrWorkBatch[] = [];
  for (const members of groups.values()) {
    const commentIds = members
      .map((i) => applies[i].commentId)
      .sort((a, b) => a - b);
    const fileSet = new Set<string>();
    for (const i of members) {
      for (const f of applies[i].affectedFiles) fileSet.add(f);
    }
    const affectedFiles = [...fileSet].sort();
    result.push({
      id: `batch-${commentIds[0]}`,
      commentIds,
      affectedFiles,
    });
  }

  result.sort((a, b) => a.commentIds[0] - b.commentIds[0]);
  return result;
}
