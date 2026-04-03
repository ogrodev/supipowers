// src/release/commit-types.ts — Single source of truth for conventional commit types

/** All valid conventional commit type prefixes. */
export const VALID_COMMIT_TYPES = [
  "feat",
  "fix",
  "refactor",
  "perf",
  "revert",
  "chore",
  "ci",
  "build",
  "test",
  "docs",
  "style",
] as const;

export type ConventionalCommitType = (typeof VALID_COMMIT_TYPES)[number];

/** Types that land in the "improvements" changelog bucket. */
export const IMPROVEMENT_TYPES = new Set<ConventionalCommitType>([
  "refactor",
  "perf",
  "revert",
]);

/** Types that land in the "maintenance" changelog bucket. */
export const MAINTENANCE_TYPES = new Set<ConventionalCommitType>([
  "chore",
  "ci",
  "build",
  "test",
  "docs",
  "style",
]);
