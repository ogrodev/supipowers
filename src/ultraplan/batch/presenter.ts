import type {
  UltraPlanBatchJournalEvent,
  UltraPlanBatchNode,
  UltraPlanBatchRun,
} from "../../types.js";
import { computeUltraPlanBatchEligibleFrontier } from "./planner.js";

function findDependencyNames(node: UltraPlanBatchNode): string {
  return node.dependencies.join(", ");
}

function findCleanupWarning(
  node: UltraPlanBatchNode,
  journal: UltraPlanBatchJournalEvent[],
): string | null {
  const match = journal.find((event) => event.sessionId === node.sessionId && event.type === "cleanup-warning");
  return match?.summary ?? null;
}

export function renderUltraPlanBatchNodeSummary(
  node: UltraPlanBatchNode,
  _run: UltraPlanBatchRun,
  journal: UltraPlanBatchJournalEvent[] = [],
): string {
  if (node.state === "merged") {
    const cleanupWarning = findCleanupWarning(node, journal);
    if (cleanupWarning) {
      return `${node.sessionId} merged with cleanup warning: ${cleanupWarning}`;
    }
    return `${node.sessionId} merged`;
  }

  if (node.state === "blocked" && node.blockerKind === "dependency") {
    return `${node.sessionId} is waiting for dependencies: ${findDependencyNames(node)}`;
  }

  if (node.state === "running") {
    return `${node.sessionId} is running`;
  }

  return `${node.sessionId} is ${node.state}`;
}

export function renderUltraPlanBatchSummary(
  run: UltraPlanBatchRun,
  journal: UltraPlanBatchJournalEvent[] = [],
): string {
  const lines: string[] = [];
  if (run.state === "blocked" && run.batchBlockerCode) {
    lines.push(`Batch blocked: ${run.batchBlockerCode}`);
    if (run.batchBlockerSummary) {
      lines.push(run.batchBlockerSummary);
    }
  } else {
    lines.push(`Batch state: ${run.state}`);
  }

  const activeWave = run.nodes
    .filter((node) => node.state !== "merged" && node.state !== "abandoned")
    .map((node) => node.waveIndex)
    .sort((left, right) => left - right)[0];
  if (activeWave !== undefined) {
    lines.push(`Active wave: ${activeWave}`);
  }

  const frontier = computeUltraPlanBatchEligibleFrontier(run).map((node) => node.sessionId);
  if (frontier.length > 0) {
    lines.push(`Frontier: ${frontier.join(", ")}`);
  }

  const runningWorkers = run.nodes.filter((node) => node.state === "running").map((node) => node.sessionId);
  if (runningWorkers.length > 0) {
    lines.push(`Running workers: ${runningWorkers.join(", ")}`);
  }

  const keptWorktrees = run.nodes
    .filter((node) => node.worktreePath !== null)
    .map((node) => node.worktreePath as string);
  if (keptWorktrees.length > 0) {
    lines.push(`Kept worktrees: ${keptWorktrees.join(", ")}`);
  }

  for (const node of run.nodes) {
    if (node.state === "blocked" && node.blockerKind === "dependency") {
      lines.push(renderUltraPlanBatchNodeSummary(node, run, journal));
      continue;
    }

    if (node.waveIndex > activeWave!
      && node.state === "pending"
      && node.dependencies.length > 0) {
      lines.push(`Later wave queued: ${node.sessionId} becomes eligible after ${findDependencyNames(node)} merges.`);
    }
  }

  return lines.join("\n");
}
