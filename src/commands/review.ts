import type { Platform } from "../platform/types.js";
import {
  inspectConfig,
  inspectQualityGateRecovery,
  loadConfig,
  removeQualityGatesConfig,
} from "../config/loader.js";
import { notifyInfo } from "../notifications/renderer.js";
import { modelRegistry } from "../config/model-registry-instance.js";
import { resolveModelForAction, createModelBridge, applyModelOverride } from "../config/model-resolver.js";
import { loadModelConfig } from "../config/model-config.js";
import { createWorkflowProgress } from "../platform/progress.js";
import { runQualityGates, type ReviewRunEvent } from "../quality/runner.js";
import {
  interactivelySaveGateSetup,
  setupGates,
} from "../quality/setup.js";
import type {
  ConfigScope,
  GateFilters,
  GateId,
  QualityGatesConfig,
  ReviewReport,
  SupipowersConfig,
} from "../types.js";
import { CANONICAL_GATE_ORDER, type GateRegistry } from "../quality/registry.js";
import { saveReviewReport } from "../storage/reports.js";
import { lspDiagnosticsGate } from "../quality/gates/lsp-diagnostics.js";
import { testSuiteGate } from "../quality/gates/test-suite.js";
import { aiReviewGate } from "../quality/gates/ai-review.js";

modelRegistry.register({
  id: "review",
  category: "command",
  label: "Review",
  harnessRoleHint: "slow",
});

const REVIEW_GATE_REGISTRY: GateRegistry = {
  "lsp-diagnostics": lspDiagnosticsGate,
  "test-suite": testSuiteGate,
  "ai-review": aiReviewGate,
};

const REVIEW_STEPS = [
  { key: "load-config", label: "Load config" },
  { key: "repair-config", label: "Repair invalid config" },
  { key: "discover-scope", label: "Discover review scope" },
  { key: "gate-lsp-diagnostics", label: "LSP diagnostics" },
  { key: "gate-test-suite", label: "Test suite" },
  { key: "gate-ai-review", label: "AI review" },
  { key: "save-report", label: "Save report" },
] as const;

export interface ReviewCommandDependencies {
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
  notifyInfo: typeof notifyInfo;
}

const REVIEW_COMMAND_DEPENDENCIES: ReviewCommandDependencies = {
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
  notifyInfo,
};

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
  return scope === "global" ? "global" : "project";
}

function buildRecoveryDetail(scopes: ConfigScope[]): string {
  const removed = scopes.map((scope) => `- Removed quality.gates from ${describeScope(scope)} config`).join("\n");
  return [
    removed,
    "",
    "Supipowers opened quality-gate setup so you can save a fresh configuration.",
  ].join("\n");
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
    title: "supi:review",
    statusKey: "supi-review",
    widgetKey: "supi-review",
    steps: [...REVIEW_STEPS],
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

  return {
    startLoadingConfig() {
      activate("load-config", "Loading review config");
    },
    completeLoadingConfig() {
      finish("load-config", "done", "loaded");
      skipIfPending("repair-config", "not needed");
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
          finish(gateStepKey(gateId), "skipped", "not configured");
          continue;
        }
        if (hasOnlyFilter && !selectedOnly.has(gateId)) {
          finish(gateStepKey(gateId), "skipped", "not selected");
          continue;
        }
        if (skipped.has(gateId)) {
          finish(gateStepKey(gateId), "skipped", "skipped by flag");
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
  deps: ReviewCommandDependencies,
  reviewProgress: ReturnType<typeof createReviewProgress>,
): Promise<
  | { status: "unrecoverable" }
  | { status: "cancelled" }
  | { status: "recovered"; config: SupipowersConfig }
> {
  const recovery = deps.inspectQualityGateRecovery(platform.paths, ctx.cwd);
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
    deps.removeQualityGatesConfig(platform.paths, ctx.cwd, scope);
  }

  deps.notifyInfo(
    ctx,
    "Removed invalid review config",
    buildRecoveryDetail(recoverableScopes),
  );

  const setupResult = await deps.setupGates(
    platform,
    ctx.cwd,
    deps.inspectConfig(platform.paths, ctx.cwd),
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
    ctx.cwd,
    setupResult.proposal,
  );
  if (saveResult !== "saved") {
    reviewProgress.skipRepair("cancelled");
    reviewProgress.cancelRemaining("cancelled");
    deps.notifyInfo(
      ctx,
      "Review cancelled",
      "Removed invalid quality.gates config, but setup was cancelled. Review did not run.",
    );
    return { status: "cancelled" };
  }

  const config = deps.loadConfig(platform.paths, ctx.cwd);
  reviewProgress.completeRepair("reconfigured");
  return {
    status: "recovered",
    config,
  };
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

export async function handleReview(
  platform: Platform,
  ctx: any,
  args: string | undefined,
  deps: ReviewCommandDependencies = REVIEW_COMMAND_DEPENDENCIES,
): Promise<void> {
  const reviewProgress = createReviewProgress(ctx);

  try {
    const modelCfg = deps.loadModelConfig(platform.paths, ctx.cwd);
    const bridge = deps.createModelBridge(platform);
    const resolved = deps.resolveModelForAction("review", modelRegistry, modelCfg, bridge);
    await deps.applyModelOverride(platform, ctx, "review", resolved);

    reviewProgress.startLoadingConfig();

    let config: SupipowersConfig;
    try {
      config = deps.loadConfig(platform.paths, ctx.cwd);
      reviewProgress.completeLoadingConfig();
    } catch (error) {
      const recovered = await recoverInvalidQualityGateConfig(platform, ctx, deps, reviewProgress);
      if (recovered.status === "unrecoverable") {
        throw error;
      }
      if (recovered.status === "cancelled") {
        return;
      }
      config = recovered.config;
    }

    const enabledGateIds = getEnabledGateIds(config.quality.gates);
    const filters = parseGateFilters(args);
    reviewProgress.configureGateSteps(config.quality.gates, filters);
    validateGateSelection(enabledGateIds, filters);

    reviewProgress.startScopeDiscovery();
    const report = await deps.runQualityGates({
      platform,
      cwd: ctx.cwd,
      gates: config.quality.gates,
      filters,
      reviewModel: resolved,
      gateRegistry: REVIEW_GATE_REGISTRY,
      onEvent: (event) => reviewProgress.handleRunnerEvent(event),
    });

    reviewProgress.startSavingReport();
    const reportPath = deps.saveReviewReport(platform.paths, ctx.cwd, report);
    reviewProgress.completeSavingReport(report.overallStatus);

    deps.notifyInfo(
      ctx,
      `Review complete: ${report.overallStatus}`,
      buildReviewSummary(report, reportPath),
    );
  } catch (error) {
    reviewProgress.failActive((error as Error).message);
    throw error;
  } finally {
    reviewProgress.dispose();
  }
}

export function registerReviewCommand(platform: Platform): void {
  platform.registerCommand("supi:review", {
    description: "Run configured quality gates",
    async handler(args: string | undefined, ctx: any) {
      await handleReview(platform, ctx, args);
    },
  });
}
