// src/git/commit-contract.ts
//
// Schema-backed contract for AI-generated commit plans. The AI must return a
// CommitPlan matching this schema; parseStructuredOutput enforces the structure
// and runWithOutputValidation retries with schema feedback on drift. Coverage
// (every staged file appears in exactly one commit) is a runtime rule that
// can't live in the schema — see validateCommitPlanCoverage.

import { type Static, Type } from "@sinclair/typebox";
import { VALID_COMMIT_TYPES } from "../release/commit-types.js";
import type { ValidationError } from "../types.js";

export const CommitGroupSchema = Type.Object(
  {
    type: Type.Union(VALID_COMMIT_TYPES.map((value) => Type.Literal(value))),
    scope: Type.Union([Type.String(), Type.Null()]),
    summary: Type.String({ minLength: 1 }),
    details: Type.Array(Type.String()),
    files: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  },
  { additionalProperties: false },
);

export const CommitPlanSchema = Type.Object(
  {
    commits: Type.Array(CommitGroupSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

export type CommitGroup = Static<typeof CommitGroupSchema>;
export type CommitPlan = Static<typeof CommitPlanSchema>;

/**
 * Verify every staged file appears in exactly one commit and that no commit
 * references a file outside the staged set. Returns an empty array on success;
 * a non-empty array indicates the plan is unusable and the caller must block.
 */
export function validateCommitPlanCoverage(
  plan: CommitPlan,
  stagedFiles: string[],
): ValidationError[] {
  const errors: ValidationError[] = [];
  const stagedSet = new Set(stagedFiles);
  const occurrences = new Map<string, number[]>();

  plan.commits.forEach((commit, commitIdx) => {
    commit.files.forEach((file, fileIdx) => {
      if (!stagedSet.has(file)) {
        errors.push({
          path: `commits[${commitIdx}].files[${fileIdx}]`,
          message: `File is not in the staged set: ${file}`,
        });
      }
      const existing = occurrences.get(file);
      if (existing) {
        existing.push(commitIdx);
      } else {
        occurrences.set(file, [commitIdx]);
      }
    });
  });

  for (const [file, commitIdxs] of occurrences) {
    if (commitIdxs.length > 1) {
      errors.push({
        path: "commits",
        message: `File appears in multiple commits (indices ${commitIdxs.join(", ")}): ${file}`,
      });
    }
  }

  for (const file of stagedFiles) {
    if (!occurrences.has(file)) {
      errors.push({
        path: "commits",
        message: `Staged file not covered by any commit: ${file}`,
      });
    }
  }

  return errors;
}
