// src/discipline/workflow-invariants.ts
//
// Runtime invariants that AI-heavy workflows must satisfy before reporting
// completion. When an invariant fails, the workflow yields a truthful
// blocker instead of silently claiming success. Used by plan/review/qa/fix-pr
// completion paths and by Phase 0 evals that test workflow boundaries.
//
// Design notes:
//   - Invariants are pure functions over a workflow-specific context object.
//   - Invariants return either `{ state: "satisfied" }` or a blocker with a
//     human-readable `reason`. Keep reasons short and actionable.
//   - `checkInvariants` returns the FIRST blocker, not a list. Workflows
//     surface one blocker at a time so the user (or the model) can fix it
//     and proceed, rather than being handed a noisy report.
//   - This module owns only the generic abstraction. Workflow-specific
//     invariant builders live next to their workflow (e.g. plan's PlanSpec
//     validation in src/planning/approval-flow.ts).

export type InvariantState =
  | { state: "satisfied" }
  | { state: "blocked"; reason: string };

export interface WorkflowInvariant<TContext> {
  /** Stable identifier. Used for logging and test assertions. */
  name: string;
  /**
   * Evaluate this invariant against the workflow context. Return a blocker
   * with a truthful reason if the invariant fails.
   */
  check: (ctx: TContext) => InvariantState | Promise<InvariantState>;
}

export type InvariantCheckResult =
  | { state: "satisfied" }
  | { state: "blocked"; invariant: string; reason: string };

/**
 * Run invariants in order against `ctx`. Stop at the first blocker and
 * return it. Returns `{ state: "satisfied" }` only when every invariant
 * reports satisfied.
 */
export async function checkInvariants<TContext>(
  invariants: readonly WorkflowInvariant<TContext>[],
  ctx: TContext,
): Promise<InvariantCheckResult> {
  for (const invariant of invariants) {
    const result = await invariant.check(ctx);
    if (result.state === "blocked") {
      return { state: "blocked", invariant: invariant.name, reason: result.reason };
    }
  }
  return { state: "satisfied" };
}

// ---------------------------------------------------------------------------
// Invariant builders — the common shapes workflows compose from
// ---------------------------------------------------------------------------

/**
 * Build an invariant that is satisfied only when the predicate returns true.
 */
export function requireCondition<TContext>(
  name: string,
  predicate: (ctx: TContext) => boolean | Promise<boolean>,
  reason: string,
): WorkflowInvariant<TContext> {
  return {
    name,
    async check(ctx) {
      const satisfied = await predicate(ctx);
      return satisfied ? { state: "satisfied" } : { state: "blocked", reason };
    },
  };
}

/**
 * Build an invariant that is satisfied only when the artifact exists. The
 * caller supplies both the existence check and the artifact identifier used
 * in the blocker reason.
 */
export function requireArtifact<TContext>(
  name: string,
  exists: (ctx: TContext) => boolean | Promise<boolean>,
  artifactLabel: string,
): WorkflowInvariant<TContext> {
  return requireCondition(
    name,
    exists,
    `Required artifact is missing: ${artifactLabel}.`,
  );
}

/**
 * Build an invariant that blocks when the workflow still has pending work.
 * Typical uses: outstanding todos, unresolved review comments, undispatched
 * follow-up steps.
 */
export function requireNoPendingWork<TContext>(
  name: string,
  pending: (ctx: TContext) => number | Promise<number>,
  workLabel: string,
): WorkflowInvariant<TContext> {
  return {
    name,
    async check(ctx) {
      const count = await pending(ctx);
      return count === 0
        ? { state: "satisfied" }
        : {
            state: "blocked",
            reason: `${count} ${workLabel} still pending \u2014 workflow cannot complete.`,
          };
    },
  };
}

/**
 * Render a blocker result as a single line for notifications, logs, or
 * prompts. `satisfied` states render as an empty string so callers can join
 * multiple results without branching.
 */
export function formatInvariantResult(result: InvariantCheckResult): string {
  if (result.state === "satisfied") return "";
  return `[${result.invariant}] ${result.reason}`;
}
