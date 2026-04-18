import type { Platform } from "../platform/types.js";
import {
  inspectConfig,
  inspectQualityGateRecovery,
  loadConfig,
  removeQualityGatesConfig,
} from "../config/loader.js";
import { notifyInfo, notifyError } from "../notifications/renderer.js";
import { modelRegistry } from "../config/model-registry-instance.js";
import { resolveModelForAction, createModelBridge, applyModelOverride } from "../config/model-resolver.js";
import { loadModelConfig } from "../config/model-config.js";
import { createWorkflowProgress } from "../platform/progress.js";
import {
  discoverChangedRepoFiles,
  runQualityGates,
  type ReviewRunEvent,
} from "../quality/runner.js";
import {
  interactivelySaveGateSetup,
  setupGates,
} from "../quality/setup.js";
import type {
  ConfigScope,
  GateFilters,
  GateId,
  GateResult,
  QualityGatesConfig,
  ReviewReport,
  SupipowersConfig,
  WorkspaceTarget,
} from "../types.js";
import { CANONICAL_GATE_ORDER, GATE_DISPLAY_NAMES } from "../quality/registry.js";
import { REVIEW_GATE_REGISTRY } from "../quality/review-gates.js";
import { saveReviewReport } from "../storage/reports.js";
import { resolvePackageManager } from "../workspace/package-manager.js";
import { resolveRepoRoot } from "../workspace/repo-root.js";
import { getChangedWorkspaceTargets } from "../workspace/path-mapping.js";
import {
  parseTargetArg,
  selectWorkspaceTarget,
  sortWorkspaceTargetOptions,
} from "../workspace/selector.js";
import { discoverWorkspaceTargets } from "../workspace/targets.js";

modelRegistry.register({
  id: "checks",
  category: "command",
  label: "Checks",
  harnessRoleHint: "slow",
});

function createReviewSteps() {
  return [
    { key: "load-config", label: "Load config" },
    { key: "repair-config", label: "Repair invalid config" },
    { key: "discover-scope", label: "Discover review scope" },
    ...CANONICAL_GATE_ORDER.map((gateId) => ({
      key: gateStepKey(gateId),
      label: GATE_DISPLAY_NAMES[gateId],
    })),
    { key: "save-report", label: "Save report" },
  ];
}

export interface ChecksCommandDependencies {
  loadModelConfig: typeof loadModelConfig;
  createModelBridge: typeof createModelBridge;
  resolveModelForAction: typeof resolveModelForAction;
  applyModelOverride: typeof applyModelOverride;
  inspectConfig: typeof inspectConfig;
  inspectQualityGateRecovery: typeof inspectQualityGateRecovery;
  loadConfig: typeof loadConfig;
  removeQualityGatesConfig: typeof removeQualityGatesConfig;
  setupGates: typeof setupGates;
  interactivelySaveGateSetup: typeof interactivelySaveGateSetup;
  runQualityGates: typeof runQualityGates;
  saveReviewReport: typeof saveReviewReport;
  resolvePackageManager: typeof resolvePackageManager;
  discoverWorkspaceTargets: typeof discoverWorkspaceTargets;
  notifyInfo: typeof notifyInfo;
}

const CHECKS_COMMAND_DEPENDENCIES: ChecksCommandDependencies = {
  loadModelConfig,
  createModelBridge,
  resolveModelForAction,
  applyModelOverride,
  inspectConfig,
  inspectQualityGateRecovery,
  loadConfig,
  removeQualityGatesConfig,
  setupGates,
  interactivelySaveGateSetup,
  runQualityGates,
  saveReviewReport,
  resolvePackageManager,
  discoverWorkspaceTargets,
  notifyInfo,
};

interface ResolvedChecksTargets {
  mode: "single" | "all";
  runTargets: WorkspaceTarget[];
  workspaceTargets: WorkspaceTarget[];
}

interface CompletedChecksRun {
  target: WorkspaceTarget;
  report: ReviewReport;
  reportPath: string;
  failedGates: GateResult[];
}

interface RunChecksForTargetInput {
  platform: Platform;
  ctx: any;
  deps: ChecksCommandDependencies;
  target: WorkspaceTarget;
  workspaceTargets: WorkspaceTarget[];
  filters: GateFilters;
  reviewModel: ReturnType<ChecksCommandDependencies["resolveModelForAction"]>;
}


function tokenizeGateList(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function extractFlagValues(args: string | undefined, flag: "--only" | "--skip"): string[] {
  if (!args) {
    return [];
  }

  const escapedFlag = flag.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const match = args.match(new RegExp(`${escapedFlag}\\s+([^]+?)(?=\\s--\\w+|$)`));
  if (!match) {
    return [];
  }

  return tokenizeGateList(match[1]);
}

function assertKnownGateIds(gateIds: string[]): GateId[] {
  const uniqueGateIds = [...new Set(gateIds)];

  for (const gateId of uniqueGateIds) {
    if (!CANONICAL_GATE_ORDER.includes(gateId as GateId)) {
      throw new Error(`Unknown gate id: ${gateId}`);
    }
  }

  return uniqueGateIds as GateId[];
}

export function parseGateFilters(args: string | undefined): GateFilters {
  const only = assertKnownGateIds(extractFlagValues(args, "--only"));
  const skip = assertKnownGateIds(extractFlagValues(args, "--skip"));

  if (only.length > 0 && skip.length > 0) {
    throw new Error("--only and --skip are mutually exclusive.");
  }

  return {
    ...(only.length > 0 ? { only } : {}),
    ...(skip.length > 0 ? { skip } : {}),
  };
}

function getEnabledGateIds(gates: QualityGatesConfig): GateId[] {
  return CANONICAL_GATE_ORDER.filter((gateId) => gates[gateId]?.enabled === true);
}

function validateGateSelection(enabledGateIds: GateId[], filters: GateFilters): void {
  if (enabledGateIds.length === 0) {
    throw new Error("No quality gates configured. Run /supi:config → Setup quality gates.");
  }

  if (filters.only) {
    for (const gateId of filters.only) {
      if (!enabledGateIds.includes(gateId)) {
        throw new Error(`Gate ${gateId} is not configured or is disabled.`);
      }
    }
  }

  const selectedGateIds = filters.only?.length
    ? enabledGateIds.filter((gateId) => filters.only?.includes(gateId))
    : enabledGateIds;
  const skippedGateIds = new Set(filters.skip ?? []);
  const runnableGateIds = selectedGateIds.filter((gateId) => !skippedGateIds.has(gateId));

  if (runnableGateIds.length === 0) {
    throw new Error("The current filters leave no selected gates to run.");
  }
}

function describeScope(scope: ConfigScope): string {
  return scope === "global" ? "global" : "repository";
}

function buildRecoveryDetail(scopes: ConfigScope[]): string {
  const removed = scopes.map((scope) => `- Removed quality.gates from ${describeScope(scope)} config`).join("\n");
  return [
    removed,
    "",
    "Supipowers opened quality-gate setup so you can save a fresh configuration.",
  ].join("\n");
}

function getTargetConfigOptions(target: WorkspaceTarget) {
  return { repoRoot: target.repoRoot };
}

function formatTargetLocation(target: WorkspaceTarget): string {
  return target.kind === "root" ? "root" : target.relativeDir;
}

function formatTargetLabel(target: WorkspaceTarget): string {
  return target.kind === "root" ? `${target.name} (root)` : `${target.name} (${target.relativeDir})`;
}

function buildChecksTargetOptionLabel(option: { target: WorkspaceTarget; changed: boolean }): string {
  return `${option.target.name} — ${formatTargetLocation(option.target)} — ${option.changed ? "changed" : "unchanged"}`;
}

function buildAllChecksTargetLabel(
  workspaceTargets: WorkspaceTarget[],
  changedTargetIds: Set<string>,
): string {
  const workspaceCount = workspaceTargets.filter((target) => target.kind === "workspace").length;
  const base = workspaceCount === 0
    ? "All — root target"
    : `All — root + ${workspaceCount} workspace${workspaceCount === 1 ? "" : "s"}`;
  const changedCount = workspaceTargets.filter((target) => changedTargetIds.has(target.id)).length;
  return changedCount > 0 ? `${base} — ${changedCount} changed` : `${base} — no changed targets`;
}

function getDefaultChecksTarget(workspaceTargets: WorkspaceTarget[]): WorkspaceTarget {
  return workspaceTargets.find((target) => target.kind === "root") ?? workspaceTargets[0]!;
}

function isMonorepoTargets(workspaceTargets: WorkspaceTarget[]): boolean {
  return workspaceTargets.some((target) => target.kind === "workspace");
}

async function resolveChecksTargets(
  platform: Platform,
  ctx: any,
  args: string | undefined,
  deps: ChecksCommandDependencies,
): Promise<ResolvedChecksTargets | null> {
  const requestedTarget = parseTargetArg(args);
  const repoRoot = await resolveRepoRoot(platform, ctx.cwd);
  const packageManager = deps.resolvePackageManager(repoRoot);
  const workspaceTargets = deps.discoverWorkspaceTargets(repoRoot, packageManager.id);

  if (workspaceTargets.length === 0) {
    throw new Error("No workspace targets found for checks.");
  }

  if (requestedTarget?.toLowerCase() === "all") {
    return { mode: "all", runTargets: workspaceTargets, workspaceTargets };
  }

  if (requestedTarget) {
    const target = await selectWorkspaceTarget(
      ctx,
      workspaceTargets.map((target) => ({ target, changed: false })),
      requestedTarget,
      {
        title: "Checks target",
        helpText: "Pick one target to run checks for. Use --target all to run the root target and every workspace target.",
      },
    );
    if (!target) {
      throw new Error(`Checks target not found: ${requestedTarget}`);
    }
    return { mode: "single", runTargets: [target], workspaceTargets };
  }

  if (!isMonorepoTargets(workspaceTargets)) {
    return {
      mode: "single",
      runTargets: [getDefaultChecksTarget(workspaceTargets)],
      workspaceTargets,
    };
  }

  const changedRepoFiles = await discoverChangedRepoFiles(platform.exec.bind(platform), repoRoot);
  const changedTargetIds = new Set(
    getChangedWorkspaceTargets(workspaceTargets, changedRepoFiles).map((target) => target.id),
  );
  const options = sortWorkspaceTargetOptions(
    workspaceTargets.map((target) => ({
      target,
      changed: changedTargetIds.has(target.id),
      label: buildChecksTargetOptionLabel({
        target,
        changed: changedTargetIds.has(target.id),
      }),
    })),
  );

  if (!ctx.hasUI) {
    return { mode: "all", runTargets: workspaceTargets, workspaceTargets };
  }

  const allLabel = buildAllChecksTargetLabel(workspaceTargets, changedTargetIds);
  const labels = [allLabel, ...options.map((option) => option.label ?? buildChecksTargetOptionLabel(option))];
  const choice = await ctx.ui.select("Checks target", labels, {
    initialIndex: 0,
    helpText: "All runs the root target and every workspace target. Choose a single target to narrow the run.",
  });
  if (!choice) {
    return null;
  }
  if (choice === allLabel) {
    return { mode: "all", runTargets: workspaceTargets, workspaceTargets };
  }

  const selectedIndex = labels.indexOf(choice) - 1;
  const target = selectedIndex >= 0 ? options[selectedIndex]?.target ?? null : null;
  return target ? { mode: "single", runTargets: [target], workspaceTargets } : null;
}

function gateStepKey(gateId: GateId): string {
  return `gate-${gateId}`;
}

function truncateDetail(detail: string, maxLength = 48): string {
  const normalized = detail.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}…`;
}

function formatScopeDetail(event: Extract<ReviewRunEvent, { type: "scope-discovered" }>): string {
  if (event.fileScope === "changed-files") {
    return `${event.changedFiles} changed file(s)`;
  }

  return `all files (${event.scopeFiles})`;
}

function createReviewProgress(ctx: any) {
  const progress = createWorkflowProgress(ctx.ui, {
    title: "supi:checks",
    statusKey: "supi-review",
    statusLabel: "Running checks...",
    widgetKey: "supi-review",
    clearStatusKeys: ["supi-model"],
    steps: createReviewSteps(),
  });
  let activeStepKey: string | null = null;

  function activate(stepKey: string, detail?: string) {
    activeStepKey = stepKey;
    progress.activate(stepKey, detail ? truncateDetail(detail) : undefined);
  }

  function finish(stepKey: string, status: "done" | "skipped" | "failed" | "blocked", detail?: string) {
    if (activeStepKey === stepKey) {
      activeStepKey = null;
    }

    const nextDetail = detail ? truncateDetail(detail) : undefined;
    switch (status) {
      case "done":
        progress.complete(stepKey, nextDetail);
        return;
      case "skipped":
        progress.skip(stepKey, nextDetail);
        return;
      case "failed":
        progress.fail(stepKey, nextDetail);
        return;
      case "blocked":
        progress.block(stepKey, nextDetail);
        return;
    }
  }

  function skipIfPending(stepKey: string, detail: string) {
    if (progress.getStatus(stepKey) === "pending") {
      finish(stepKey, "skipped", detail);
    }
  }

  function hideIfPending(stepKey: string) {
    if (progress.getStatus(stepKey) === "pending") {
      progress.hide(stepKey);
    }
  }

  return {
    startLoadingConfig() {
      activate("load-config", "Loading checks config");
    },
    completeLoadingConfig() {
      finish("load-config", "done", "loaded");
      hideIfPending("repair-config");
    },
    blockLoadingConfig(detail: string) {
      finish("load-config", "blocked", detail);
    },
    failLoadingConfig(detail: string) {
      finish("load-config", "failed", detail);
    },
    startRepair(detail: string) {
      activate("repair-config", detail);
    },
    updateRepair(detail: string) {
      if (activeStepKey === "repair-config") {
        progress.detail(truncateDetail(detail));
        return;
      }
      activate("repair-config", detail);
    },
    completeRepair(detail: string) {
      finish("repair-config", "done", detail);
    },
    skipRepair(detail: string) {
      finish("repair-config", "skipped", detail);
    },
    failRepair(detail: string) {
      finish("repair-config", "failed", detail);
    },
    configureGateSteps(gates: QualityGatesConfig, filters: GateFilters) {
      const selectedOnly = new Set(filters.only ?? []);
      const skipped = new Set(filters.skip ?? []);
      const hasOnlyFilter = selectedOnly.size > 0;

      for (const gateId of CANONICAL_GATE_ORDER) {
        if (gates[gateId]?.enabled !== true) {
          progress.hide(gateStepKey(gateId));
          continue;
        }
        if (hasOnlyFilter && !selectedOnly.has(gateId)) {
          progress.hide(gateStepKey(gateId));
          continue;
        }
        if (skipped.has(gateId)) {
          progress.hide(gateStepKey(gateId));
        }
      }
    },
    startScopeDiscovery() {
      activate("discover-scope", "Inspecting repository");
    },
    handleRunnerEvent(event: ReviewRunEvent) {
      if (event.type === "scope-discovered") {
        finish("discover-scope", "done", formatScopeDetail(event));
        return;
      }

      if (event.type === "gate-started") {
        activate(gateStepKey(event.gateId), "running");
        return;
      }

      if (event.type === "gate-skipped") {
        finish(gateStepKey(event.gateId), "skipped", event.reason);
        return;
      }

      const status =
        event.status === "passed"
          ? "done"
          : event.status === "failed"
            ? "failed"
            : event.status === "blocked"
              ? "blocked"
              : "skipped";
      finish(gateStepKey(event.gateId), status, event.summary);
    },
    startSavingReport() {
      activate("save-report", "Writing report");
    },
    completeSavingReport(status: ReviewReport["overallStatus"]) {
      finish("save-report", "done", status);
    },
    cancelRemaining(detail: string) {
      skipIfPending("discover-scope", detail);
      for (const gateId of CANONICAL_GATE_ORDER) {
        skipIfPending(gateStepKey(gateId), detail);
      }
      skipIfPending("save-report", detail);
    },
    failActive(detail: string) {
      if (!activeStepKey) {
        return;
      }
      finish(activeStepKey, "failed", detail);
    },
    dispose() {
      progress.dispose();
    },
  };
}

async function recoverInvalidQualityGateConfig(
  platform: Platform,
  ctx: any,
  deps: ChecksCommandDependencies,
  reviewProgress: ReturnType<typeof createReviewProgress>,
  target: WorkspaceTarget,
): Promise<
  | { status: "unrecoverable" }
  | { status: "cancelled" }
  | { status: "recovered"; config: SupipowersConfig }
> {
  const configRoot = target.repoRoot;
  const configOptions = getTargetConfigOptions(target);
  const recovery = deps.inspectQualityGateRecovery(platform.paths, configRoot, configOptions);
  const recoverableScopes = recovery.scopes
    .filter((scope) => scope.recoverableInvalidQualityGates)
    .map((scope) => scope.scope);
  const hasBlockingParseErrors = recovery.scopes.some((scope) => scope.parseError !== null);
  const hasBlockingValidationErrors = recovery.scopes.some(
    (scope) => scope.otherValidationErrors.length > 0,
  );

  if (recoverableScopes.length === 0 || hasBlockingParseErrors || hasBlockingValidationErrors) {
    reviewProgress.failLoadingConfig("invalid config");
    reviewProgress.skipRepair("not recoverable");
    return { status: "unrecoverable" };
  }

  reviewProgress.blockLoadingConfig("invalid quality.gates");
  reviewProgress.startRepair(`cleaning ${recoverableScopes.join(" + ")}`);

  for (const scope of recoverableScopes) {
    deps.removeQualityGatesConfig(platform.paths, configRoot, scope, configOptions);
  }

  deps.notifyInfo(
    ctx,
    "Removed invalid review config",
    buildRecoveryDetail(recoverableScopes),
  );

  const setupResult = await deps.setupGates(
    platform,
    configRoot,
    deps.inspectConfig(platform.paths, configRoot, configOptions),
    { mode: "deterministic" },
  );
  if (setupResult.status !== "proposed") {
    reviewProgress.failRepair("setup proposal failed");
    throw new Error(
      setupResult.errors?.join("\n") ?? "Unable to build a valid quality-gate setup proposal.",
    );
  }

  reviewProgress.updateRepair("waiting for setup");
  const saveResult = await deps.interactivelySaveGateSetup(
    ctx,
    platform.paths,
    configRoot,
    setupResult.proposal,
  );
  if (saveResult !== "saved") {
    reviewProgress.skipRepair("cancelled");
    reviewProgress.cancelRemaining("cancelled");
    deps.notifyInfo(
      ctx,
      "Checks cancelled",
      "Removed invalid quality.gates config, but setup was cancelled. Checks did not run.",
    );
    return { status: "cancelled" };
  }

  const config = deps.loadConfig(platform.paths, configRoot, configOptions);
  reviewProgress.completeRepair("reconfigured");
  return {
    status: "recovered",
    config,
  };
}

async function runChecksForTarget(input: RunChecksForTargetInput): Promise<CompletedChecksRun | null> {
  const { platform, ctx, deps, target, workspaceTargets, filters, reviewModel } = input;
  const reviewProgress = createReviewProgress(ctx);
  const configRoot = target.repoRoot;
  const configOptions = getTargetConfigOptions(target);

  try {
    reviewProgress.startLoadingConfig();

    let config: SupipowersConfig;
    try {
      config = deps.loadConfig(platform.paths, configRoot, configOptions);
      reviewProgress.completeLoadingConfig();
    } catch (error) {
      const recovered = await recoverInvalidQualityGateConfig(
        platform,
        ctx,
        deps,
        reviewProgress,
        target,
      );
      if (recovered.status === "unrecoverable") {
        throw error;
      }
      if (recovered.status === "cancelled") {
        return null;
      }
      config = recovered.config;
    }

    const enabledGateIds = getEnabledGateIds(config.quality.gates);
    reviewProgress.configureGateSteps(config.quality.gates, filters);
    validateGateSelection(enabledGateIds, filters);

    reviewProgress.startScopeDiscovery();
    const report = await deps.runQualityGates({
      platform,
      cwd: target.packageDir,
      target,
      workspaceTargets,
      gates: config.quality.gates,
      filters,
      reviewModel,
      gateRegistry: REVIEW_GATE_REGISTRY,
      onEvent: (event) => reviewProgress.handleRunnerEvent(event),
    });

    reviewProgress.startSavingReport();
    const reportPath = deps.saveReviewReport(platform.paths, target, report);
    reviewProgress.completeSavingReport(report.overallStatus);

    return {
      target,
      report,
      reportPath,
      failedGates: getFailedGates(report),
    };
  } catch (error) {
    reviewProgress.failActive((error as Error).message);
    throw error;
  } finally {
    reviewProgress.dispose();
  }
}

function buildBatchChecksTitle(results: CompletedChecksRun[]): string {
  const counts = results.reduce(
    (summary, result) => {
      summary[result.report.overallStatus] += 1;
      return summary;
    },
    { passed: 0, failed: 0, blocked: 0 } satisfies Record<ReviewReport["overallStatus"], number>,
  );
  const parts = [
    counts.passed > 0 ? `${counts.passed} passed` : null,
    counts.failed > 0 ? `${counts.failed} failed` : null,
    counts.blocked > 0 ? `${counts.blocked} blocked` : null,
  ].filter((part): part is string => part !== null);

  return `Checks complete: ${parts.join(", ")}`;
}

function buildBatchChecksSummary(results: CompletedChecksRun[]): string {
  return results.map((result) => {
    const { passed, failed, blocked, skipped } = result.report.summary;
    return `${formatTargetLabel(result.target)}: ${result.report.overallStatus} — ${passed} passed, ${failed} failed, ${blocked} blocked, ${skipped} skipped — saved: ${result.reportPath}`;
  }).join("\n");
}


export function buildReviewSummary(report: ReviewReport, reportPath: string): string {
  const orderedGates = [...report.gates].sort(
    (left, right) =>
      CANONICAL_GATE_ORDER.indexOf(left.gate) - CANONICAL_GATE_ORDER.indexOf(right.gate),
  );

  return [
    `passed: ${report.summary.passed} | failed: ${report.summary.failed} | blocked: ${report.summary.blocked} | skipped: ${report.summary.skipped}`,
    ...orderedGates.map((gate) => `${gate.gate}: ${gate.status}`),
    `saved: ${reportPath}`,
  ].join("\n");
}

function getFailedGates(report: ReviewReport): GateResult[] {
  return report.gates
    .filter((gate) => gate.status === "failed" || gate.status === "blocked")
    .sort(
      (left, right) =>
        CANONICAL_GATE_ORDER.indexOf(left.gate) - CANONICAL_GATE_ORDER.indexOf(right.gate),
    );
}

/**
 * Build a compact, user-facing failure summary.
 * Only error-severity issues are shown; passed gates and info/warnings are omitted.
 */
export function buildFailureSummary(failedGates: GateResult[]): string {
  const sections: string[] = [];

  for (const gate of failedGates) {
    const label = GATE_DISPLAY_NAMES[gate.gate] ?? gate.gate;
    const errors = gate.issues.filter((issue) => issue.severity === "error");

    if (errors.length === 0) {
      // Gate failed/blocked but reported no error-level issues — show the summary
      sections.push(`${label}: ${gate.summary}`);
      continue;
    }

    const lines = errors.map((issue) => {
      const loc = issue.file
        ? issue.line
          ? `${issue.file}:${issue.line}`
          : issue.file
        : undefined;
      return loc ? `  ${loc} — ${issue.message}` : `  ${issue.message}`;
    });

    sections.push(`${label} (${errors.length} error${errors.length === 1 ? "" : "s"}):\n${lines.join("\n")}`);
  }

  return sections.join("\n\n");
}

/**
 * Build a steer prompt that gives the LLM full failure context to fix issues.
 */
// Patterns that identify passing-test lines across common test runners.
// Lines matching these are noise when sending failure context to the LLM.
const PASSING_TEST_PATTERNS = [
  // bun:test, vitest
  /^\s*\(pass\)\s/,
  // jest, mocha — ✓ or √ prefix
  /^\s*[✓√]\s/,
  // jest file-level PASS
  /^\s*PASS\s/,
  // pytest — lines ending with PASSED or PASSED in brackets
  /\bPASSED\s*$/,
  // pytest compact dot-progress lines (all dots, no F/E)
  /^\s*[\.]+\s*$/,
  // pytest short summary: "X passed" without failures
  /^\s*=+\s*\d+\s+passed(?!.*failed).*=+\s*$/,
];

/**
 * Strip passing-test lines from raw test runner output.
 * Keeps failures, errors, stack traces, and summary lines.
 */
export function filterTestRunnerOutput(raw: string): string {
  const lines = raw.split("\n");
  const filtered = lines.filter(
    (line) => !PASSING_TEST_PATTERNS.some((pattern) => pattern.test(line)),
  );

  // Collapse runs of 3+ blank lines into 1
  const collapsed: string[] = [];
  let blankRun = 0;
  for (const line of filtered) {
    if (line.trim() === "") {
      blankRun++;
      if (blankRun <= 1) collapsed.push(line);
    } else {
      blankRun = 0;
      collapsed.push(line);
    }
  }

  return collapsed.join("\n").trim();
}

function buildFixPrompt(failedGates: GateResult[]): string {
  const sections: string[] = [];

  for (const gate of failedGates) {
    const label = GATE_DISPLAY_NAMES[gate.gate] ?? gate.gate;
    const errors = gate.issues.filter((issue) => issue.severity === "error");

    const issueLines = errors.map((issue) => {
      const parts = [issue.message];
      if (issue.file) parts.push(`file: ${issue.file}${issue.line ? `:${issue.line}` : ""}`);
      if (issue.detail) {
        const detail = gate.gate === "test-suite"
          ? filterTestRunnerOutput(issue.detail)
          : issue.detail;
        parts.push(`detail:\n${detail}`);
      }
      return `- ${parts.join(" | ")}`;
    });

    sections.push([
      `## ${label} (${gate.status})`,
      gate.summary,
      ...(issueLines.length > 0 ? ["", ...issueLines] : []),
    ].join("\n"));
  }

  const rerunCmd = `/supi:checks --only ${failedGates.map((g) => g.gate).join(" ")}`;

  return [
    "Quality checks found failures that need fixing.",
    `Fix the issues below, then run \`${rerunCmd}\` to validate your fixes.`,
    "",
    ...sections,
  ].join("\n");
}

export async function handleChecks(
  platform: Platform,
  ctx: any,
  args: string | undefined,
  deps: ChecksCommandDependencies = CHECKS_COMMAND_DEPENDENCIES,
): Promise<void> {
  let modelCleanup: (() => Promise<void>) | undefined;

  try {
    const modelCfg = deps.loadModelConfig(platform.paths, ctx.cwd);
    const bridge = deps.createModelBridge(platform);
    const resolved = deps.resolveModelForAction("checks", modelRegistry, modelCfg, bridge);
    modelCleanup = await deps.applyModelOverride(platform, ctx, "checks", resolved);

    const filters = parseGateFilters(args);
    const selection = await resolveChecksTargets(platform, ctx, args, deps);
    if (!selection) {
      return;
    }

    const results: CompletedChecksRun[] = [];
    for (const target of selection.runTargets) {
      const result = await runChecksForTarget({
        platform,
        ctx,
        deps,
        target,
        workspaceTargets: selection.workspaceTargets,
        filters,
        reviewModel: resolved,
      });
      if (!result) {
        return;
      }
      results.push(result);
    }

    if (selection.mode === "all" && results.length > 1) {
      deps.notifyInfo(ctx, buildBatchChecksTitle(results), buildBatchChecksSummary(results));
      return;
    }

    const [result] = results;
    if (!result) {
      return;
    }

    if (result.failedGates.length === 0) {
      deps.notifyInfo(
        ctx,
        `Checks complete: ${result.report.overallStatus}`,
        buildReviewSummary(result.report, result.reportPath),
      );
      return;
    }

    const failureNames = result.failedGates.map((gate) => GATE_DISPLAY_NAMES[gate.gate] ?? gate.gate);
    deps.notifyInfo(
      ctx,
      `Checks complete: ${result.report.overallStatus}`,
      buildFailureSummary(result.failedGates),
    );

    const FIX_NOW = `Yes, fix ${failureNames.join(", ")}`;
    const SAVE_ONLY = "No, just save for later";
    const choice = await ctx.ui.select(
      `${result.failedGates.length} check${result.failedGates.length === 1 ? "" : "s"} failed — do you want to fix now?`,
      [FIX_NOW, SAVE_ONLY],
    );

    if (choice === FIX_NOW) {
      platform.sendUserMessage(buildFixPrompt(result.failedGates));
    }
  } finally {
    await modelCleanup?.();
  }
}

export function handleChecksCommand(platform: Platform, ctx: any, args?: string): void {
  handleChecks(platform, ctx, args).catch((error) => {
    notifyError(ctx, "Checks failed", (error as Error).message);
  });
}

export function registerChecksCommand(platform: Platform): void {
  platform.registerCommand("supi:checks", {
    description: "Run configured quality gates",
    async handler(args: string | undefined, ctx: any) {
      try {
        await handleChecks(platform, ctx, args);
      } catch (error) {
        notifyError(ctx, "Checks failed", (error as Error).message);
      }
    },
  });
}
