// src/quality/runner.ts
import path from "node:path";
import type { ExecOptions, ExecResult, Platform } from "../platform/types.js";
import type {
  GateDefinition,
  GateExecutionContext,
  GateFilters,
  GateId,
  GateResult,
  GateSummary,
  QualityGatesConfig,
  ResolvedModel,
  ReviewReport,
  WorkspaceTarget,
} from "../types.js";
import { collectLspDiagnostics } from "../lsp/bridge.js";
import { filterPathsForWorkspaceTarget, normalizeRepoPath } from "../workspace/path-mapping.js";
import { createExecShell } from "../utils/shell.js";
import { CANONICAL_GATE_ORDER, type GateRegistry } from "./registry.js";

interface ReviewScope {
  changedFiles: string[];
  scopeFiles: string[];
  fileScope: GateExecutionContext["fileScope"];
}

export type ReviewRunEvent =
  | {
      type: "scope-discovered";
      changedFiles: number;
      scopeFiles: number;
      fileScope: GateExecutionContext["fileScope"];
    }
  | { type: "gate-started"; gateId: GateId }
  | { type: "gate-skipped"; gateId: GateId; reason: string }
  | {
      type: "gate-completed";
      gateId: GateId;
      status: GateResult["status"];
      summary: string;
    };

export interface RunQualityGatesInput {
  platform: Pick<Platform, "exec" | "getActiveTools" | "createAgentSession">;
  cwd: string;
  target: WorkspaceTarget;
  workspaceTargets: WorkspaceTarget[];
  gates: QualityGatesConfig;
  filters: GateFilters;
  reviewModel: ResolvedModel;
  gateRegistry?: GateRegistry;
  getLspDiagnostics?: GateExecutionContext["getLspDiagnostics"];
  now?: () => Date;
  onEvent?: (event: ReviewRunEvent) => void;
}

function isGateEnabled(config: QualityGatesConfig[GateId] | undefined): boolean {
  if (!config) {
    return false;
  }

  return config.enabled === true;
}

function normalizeFileList(...chunks: string[]): string[] {
  const seen = new Set<string>();

  for (const chunk of chunks) {
    for (const line of chunk.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      seen.add(normalizeRepoPath(trimmed));
    }
  }

  return [...seen];
}

async function safeExec(
  exec: Platform["exec"],
  cmd: string,
  args: string[],
  opts?: ExecOptions,
): Promise<ExecResult> {
  try {
    return await exec(cmd, args, opts);
  } catch (error) {
    return {
      stdout: "",
      stderr: (error as Error).message,
      code: 1,
    };
  }
}

export async function discoverChangedRepoFiles(
  exec: Platform["exec"],
  repoRoot: string,
): Promise<string[]> {
  const head = await safeExec(exec, "git", ["diff", "--name-only", "HEAD"], { cwd: repoRoot });
  const cached = await safeExec(exec, "git", ["diff", "--name-only", "--cached"], { cwd: repoRoot });
  const untracked = await safeExec(exec, "git", ["ls-files", "--others", "--exclude-standard"], {
    cwd: repoRoot,
  });

  return normalizeFileList(head.stdout, cached.stdout, untracked.stdout);
}

async function discoverTrackedRepoFiles(
  exec: Platform["exec"],
  repoRoot: string,
): Promise<string[]> {
  const tracked = await safeExec(exec, "git", ["ls-files"], { cwd: repoRoot });
  return normalizeFileList(tracked.stdout);
}

function mapRepoPathsToTargetPaths(
  workspaceTargets: WorkspaceTarget[],
  target: WorkspaceTarget,
  repoRelativePaths: string[],
): string[] {
  return filterPathsForWorkspaceTarget(workspaceTargets, target, repoRelativePaths).map((repoRelativePath) =>
    normalizeRepoPath(path.relative(target.packageDir, path.join(target.repoRoot, repoRelativePath))),
  );
}

export async function discoverReviewScope(
  exec: Platform["exec"],
  repoRoot: string,
  workspaceTargets: WorkspaceTarget[],
  target: WorkspaceTarget,
): Promise<ReviewScope> {
  const changedFiles = mapRepoPathsToTargetPaths(
    workspaceTargets,
    target,
    await discoverChangedRepoFiles(exec, repoRoot),
  );

  if (changedFiles.length > 0) {
    return {
      changedFiles,
      scopeFiles: changedFiles,
      fileScope: "changed-files",
    };
  }

  const scopeFiles = mapRepoPathsToTargetPaths(
    workspaceTargets,
    target,
    await discoverTrackedRepoFiles(exec, repoRoot),
  );

  return {
    changedFiles: [],
    scopeFiles,
    fileScope: "all-files",
  };
}

function selectConfiguredGates(gates: QualityGatesConfig, filters: GateFilters): GateId[] {
  const enabledGates = CANONICAL_GATE_ORDER.filter((gateId) =>
    isGateEnabled(gates[gateId]),
  );

  if (filters.only && filters.only.length > 0) {
    const only = new Set(filters.only);
    return enabledGates.filter((gateId) => only.has(gateId));
  }

  return enabledGates;
}


function createGateExecutionContext(
  input: RunQualityGatesInput,
  scope: ReviewScope,
): GateExecutionContext {
  const exec: GateExecutionContext["exec"] = (cmd, args, opts) =>
    input.platform.exec(cmd, args, { cwd: input.cwd, ...opts });
  const createAgentSession = input.platform.createAgentSession.bind(input.platform);
  const activeTools = input.platform.getActiveTools();
  const reviewModel = {
    model: input.reviewModel.model,
    thinkingLevel: input.reviewModel.thinkingLevel,
  };

  return {
    cwd: input.cwd,
    changedFiles: scope.changedFiles,
    scopeFiles: scope.scopeFiles,
    fileScope: scope.fileScope,
    exec,
    execShell: createExecShell(exec),
    getLspDiagnostics:
      input.getLspDiagnostics ??
      ((scopeFiles, fileScope) =>
        collectLspDiagnostics({
          cwd: input.cwd,
          scopeFiles,
          fileScope,
          createAgentSession,
          reviewModel,
        })),
    createAgentSession,
    activeTools,
    reviewModel,
  };
}

function createSkippedGateResult(gate: GateId, reason = "Skipped by filter"): GateResult {
  return {
    gate,
    status: "skipped",
    summary: reason,
    issues: [],
  };
}

async function runConfiguredGate(
  gateId: GateId,
  registry: GateRegistry,
  context: GateExecutionContext,
  gates: QualityGatesConfig,
): Promise<GateResult> {
  const definition = registry[gateId] as GateDefinition<NonNullable<QualityGatesConfig[typeof gateId]>> | undefined;
  if (!definition) {
    throw new Error(`Gate definition not registered: ${gateId}`);
  }

  const config = gates[gateId];
  if (!config || config.enabled !== true) {
    throw new Error(`Gate ${gateId} is not enabled`);
  }

  return definition.run(context, config as NonNullable<QualityGatesConfig[typeof gateId]>);
}

export function summarizeGateStatuses(gates: GateResult[]): GateSummary {
  return gates.reduce<GateSummary>(
    (summary, gate) => {
      summary[gate.status] += 1;
      return summary;
    },
    { passed: 0, failed: 0, skipped: 0, blocked: 0 },
  );
}

export function computeOverallStatus(summary: GateSummary): ReviewReport["overallStatus"] {
  if (summary.blocked > 0) {
    return "blocked";
  }
  if (summary.failed > 0) {
    return "failed";
  }
  return "passed";
}

export async function runQualityGates(input: RunQualityGatesInput): Promise<ReviewReport> {
  const selectedGates = selectConfiguredGates(input.gates, input.filters);
  const scope = await discoverReviewScope(
    input.platform.exec.bind(input.platform),
    input.target.repoRoot,
    input.workspaceTargets,
    input.target,
  );
  input.onEvent?.({
    type: "scope-discovered",
    changedFiles: scope.changedFiles.length,
    scopeFiles: scope.scopeFiles.length,
    fileScope: scope.fileScope,
  });
  const context = createGateExecutionContext(input, scope);
  const skipped = new Set(input.filters.skip ?? []);
  const registry = input.gateRegistry ?? {};
  const gates: GateResult[] = [];

  // Run all gates concurrently — each gate is independent (no shared mutable state)
  const promises = selectedGates.map(async (gateId): Promise<GateResult> => {
    if (skipped.has(gateId)) {
      input.onEvent?.({ type: "gate-skipped", gateId, reason: "Skipped by filter" });
      return createSkippedGateResult(gateId);
    }

    input.onEvent?.({ type: "gate-started", gateId });
    const result = await runConfiguredGate(gateId, registry, context, input.gates);
    input.onEvent?.({
      type: "gate-completed",
      gateId,
      status: result.status,
      summary: result.summary,
    });
    return result;
  });

  gates.push(...await Promise.all(promises));

  const summary = summarizeGateStatuses(gates);

  return {
    timestamp: (input.now ?? (() => new Date()))().toISOString(),
    selectedGates,
    gates,
    summary,
    overallStatus: computeOverallStatus(summary),
  };
}
