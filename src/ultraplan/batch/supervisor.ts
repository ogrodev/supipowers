import type {
  UltraPlanBatchNode,
  UltraPlanBatchNodeBlockerKind,
  UltraPlanBatchRun,
} from "../../types.js";
import type { UltraPlanRunOutcome } from "../execution/session-runner.js";
import { computeUltraPlanBatchEligibleFrontier } from "./planner.js";
import type { UltraPlanBatchMergeResult } from "./merge.js";

export type UltraPlanBatchWorkerOutcome =
  | UltraPlanRunOutcome
  | {
      kind: "blocked";
      blockerKind: Exclude<UltraPlanBatchNodeBlockerKind, "dependency" | "merge">;
      summary: string;
    };

export interface UltraPlanBatchSupervisorDeps {
  computeFrontier(run: UltraPlanBatchRun): UltraPlanBatchNode[];
  runWorker(
    node: UltraPlanBatchNode,
    run: UltraPlanBatchRun,
  ): Promise<UltraPlanBatchWorkerOutcome | null> | UltraPlanBatchWorkerOutcome | null;
  mergeNode(
    node: UltraPlanBatchNode,
    run: UltraPlanBatchRun,
  ): Promise<UltraPlanBatchMergeResult | null> | UltraPlanBatchMergeResult | null;
}

export interface RunUltraPlanBatchSupervisorInput {
  run: UltraPlanBatchRun;
  deps?: Partial<UltraPlanBatchSupervisorDeps>;
}

export interface ResumeUltraPlanBatchSupervisorInput {
  run: UltraPlanBatchRun;
  deps?: Partial<UltraPlanBatchSupervisorDeps>;
}

function buildDeps(overrides: RunUltraPlanBatchSupervisorInput["deps"]): UltraPlanBatchSupervisorDeps {
  return {
    computeFrontier: overrides?.computeFrontier ?? computeUltraPlanBatchEligibleFrontier,
    runWorker: overrides?.runWorker ?? (async () => null),
    mergeNode: overrides?.mergeNode ?? (async () => null),
  };
}

function cloneRun(run: UltraPlanBatchRun): UltraPlanBatchRun {
  return {
    ...run,
    nodes: run.nodes.map((node) => ({ ...node })),
    waves: run.waves.map((wave) => ({ ...wave, sessionIds: [...wave.sessionIds] })),
  };
}

function clearBatchBlocker(run: UltraPlanBatchRun): void {
  run.batchBlockerCode = null;
  run.batchBlockerSummary = null;
}

function assertLegalStateTransition(run: UltraPlanBatchRun): void {
  const allTerminal = run.nodes.every((node) => node.state === "merged" || node.state === "abandoned");
  if (run.state === "blocked" && !run.batchResumeRequestedAt && allTerminal) {
    throw new Error("blocked batch cannot complete without resume approval");
  }
  if (
    (run.state === "paused" || run.state === "blocked")
    && !run.batchResumeRequestedAt
    && run.nodes.some((node) => node.state === "merge-pending")
  ) {
    throw new Error(`${run.state} batch cannot enter merge-pending without resume approval`);
  }
}

function findNode(run: UltraPlanBatchRun, sessionId: string): UltraPlanBatchNode {
  const node = run.nodes.find((candidate) => candidate.sessionId === sessionId);
  if (!node) {
    throw new Error(`unknown batch node ${sessionId}`);
  }
  return node;
}

function countRunningWorkers(run: UltraPlanBatchRun): number {
  return run.nodes.filter((node) => node.state === "preparing" || node.state === "running").length;
}

function settleMergeResult(run: UltraPlanBatchRun, node: UltraPlanBatchNode, result: UltraPlanBatchMergeResult): void {
  if (result.kind === "merged") {
    node.state = "merged";
    node.blockerKind = null;
    node.blockerSummary = null;
    node.worktreePath = result.worktreePath;
    run.currentBaseHead = result.currentBaseHead;
    return;
  }

  node.state = "blocked";
  node.blockerSummary = result.summary;
  node.blockerKind = result.code === "merge-blocked" ? "merge" : "supervisor";
  node.worktreePath = result.worktreePath;

  if (result.code !== "merge-blocked") {
    run.state = "blocked";
    run.batchBlockerCode = result.code;
    run.batchBlockerSummary = result.summary;
    return;
  }

  blockDependentNodes(run, node.sessionId);
}

function blockDependentNodes(run: UltraPlanBatchRun, dependencySessionId: string): void {
  for (const node of run.nodes) {
    if (!node.dependencies.includes(dependencySessionId)) {
      continue;
    }
    if (node.state === "merged" || node.state === "abandoned") {
      continue;
    }
    node.state = "blocked";
    node.blockerKind = "dependency";
    node.blockerSummary = `waiting for ${dependencySessionId}`;
  }
}

function settleWorkerOutcome(node: UltraPlanBatchNode, outcome: UltraPlanBatchWorkerOutcome | null): void {
  if (outcome === null) {
    node.state = "running";
    return;
  }

  if (outcome.kind === "blocked") {
    node.state = "blocked";
    node.blockerKind = outcome.blockerKind;
    node.blockerSummary = outcome.summary;
    return;
  }

  if (outcome.kind === "completed") {
    node.state = "merge-pending";
    node.blockerKind = null;
    node.blockerSummary = null;
    return;
  }

  if (outcome.session.state === "awaiting-user") {
    node.state = "awaiting-user";
  } else {
    node.state = "blocked";
  }
  node.blockerKind = "session";
  node.blockerSummary = outcome.session.blocker?.message ?? `worker returned ${outcome.session.state}`;
}

function finalizeBatchState(run: UltraPlanBatchRun): UltraPlanBatchRun {
  if (run.batchBlockerCode) {
    run.state = "blocked";
    return run;
  }

  if (run.nodes.some((node) => node.state === "preparing" || node.state === "running" || node.state === "merge-pending")) {
    run.state = "running";
    clearBatchBlocker(run);
    return run;
  }

  if (run.nodes.every((node) => node.state === "merged" || node.state === "abandoned")) {
    run.state = "complete";
    clearBatchBlocker(run);
    return run;
  }

  run.state = "paused";
  clearBatchBlocker(run);
  return run;
}

function resetNodeForResume(node: UltraPlanBatchNode): void {
  if (node.state === "preparing") {
    node.state = "pending";
    return;
  }

  if (node.state === "running") {
    node.state = "blocked";
    node.blockerKind = "session";
    node.blockerSummary = "restart reconciliation requires an explicit retry";
    return;
  }

  if (!node.resumeRequestedAt) {
    return;
  }

  if (node.state === "paused" || node.state === "awaiting-user") {
    node.state = "pending";
  } else if (node.state === "blocked" && node.blockerKind === "merge") {
    node.state = "merge-pending";
  } else if (node.state === "blocked" && node.blockerKind !== "dependency") {
    node.state = "pending";
  } else {
    return;
  }

  node.blockerKind = null;
  node.blockerSummary = null;
  node.resumeRequestedAt = null;
}

function reconcileRunForResume(run: UltraPlanBatchRun): UltraPlanBatchRun {
  const next = cloneRun(run);
  if (next.state === "blocked" && next.batchBlockerCode !== null && next.batchResumeRequestedAt !== null) {
    next.state = "running";
    next.batchResumeRequestedAt = null;
    clearBatchBlocker(next);
  } else if (next.state === "paused") {
    next.state = "running";
  }

  for (const node of next.nodes) {
    resetNodeForResume(node);
  }

  return next;
}

function hasInFlightWork(run: UltraPlanBatchRun): boolean {
  return run.nodes.some((node) => node.state === "preparing" || node.state === "running" || node.state === "merge-pending");
}

async function runSupervisorPass(input: RunUltraPlanBatchSupervisorInput): Promise<UltraPlanBatchRun> {
  assertLegalStateTransition(input.run);
  const deps = buildDeps(input.deps);
  const next = cloneRun(input.run);

  const mergePending = next.nodes.find((node) => node.state === "merge-pending");
  if (mergePending) {
    const mergeResult = await deps.mergeNode(mergePending, next);
    if (mergeResult) {
      settleMergeResult(next, mergePending, mergeResult);
    }
  }

  const blockNewLaunches = next.state === "blocked" && next.batchBlockerCode !== null;

  const inFlightNodes = next.nodes.filter((candidate) => candidate.state === "preparing" || candidate.state === "running");
  const inFlightOutcomes = await Promise.all(
    inFlightNodes.map(async (node) => [node.sessionId, await deps.runWorker(node, next)] as const),
  );
  for (const [sessionId, outcome] of inFlightOutcomes) {
    settleWorkerOutcome(findNode(next, sessionId), outcome);
  }

  if (!blockNewLaunches) {
    const availableSlots = Math.max(0, next.maxParallelism - countRunningWorkers(next));
    const frontierNodes = deps.computeFrontier(next)
      .slice(0, availableSlots)
      .map((node) => findNode(next, node.sessionId));
    for (const node of frontierNodes) {
      node.blockerKind = null;
      node.blockerSummary = null;
    }
    const frontierOutcomes = await Promise.all(
      frontierNodes.map(async (node) => [node.sessionId, await deps.runWorker(node, next)] as const),
    );
    for (const [sessionId, outcome] of frontierOutcomes) {
      settleWorkerOutcome(findNode(next, sessionId), outcome);
    }
  }

  return finalizeBatchState(next);
}

export async function runUltraPlanBatchSupervisor(
  input: RunUltraPlanBatchSupervisorInput,
 ): Promise<UltraPlanBatchRun> {
  return runSupervisorPass(input);
}

export async function resumeUltraPlanBatchSupervisor(
  input: ResumeUltraPlanBatchSupervisorInput,
 ): Promise<UltraPlanBatchRun> {
  return runSupervisorPass({
    run: reconcileRunForResume(input.run),
    deps: input.deps,
  });
}

export function abandonUltraPlanBatchRun(run: UltraPlanBatchRun): UltraPlanBatchRun {
  if (hasInFlightWork(run)) {
    throw new Error("cannot abandon a batch while work is in flight");
  }

  const next = cloneRun(run);
  next.state = "abandoned";
  clearBatchBlocker(next);
  next.nodes = next.nodes.map((node) => ({
    ...node,
    state: node.state === "merged" ? "merged" : "abandoned",
    blockerKind: null,
    blockerSummary: null,
  }));
  return next;
}

export function abandonUltraPlanBatchNode(run: UltraPlanBatchRun, sessionId: string): UltraPlanBatchRun {
  if (hasInFlightWork(run)) {
    throw new Error("cannot abandon a batch node while work is in flight");
  }

  const next = cloneRun(run);
  const node = findNode(next, sessionId);
  node.state = "abandoned";
  node.blockerKind = null;
  node.blockerSummary = null;
  return finalizeBatchState(next);
}