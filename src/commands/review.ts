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
import { runQualityGates, type ReviewRunEvent } from "../quality/runner.js";
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
} from "../types.js";
import { CANONICAL_GATE_ORDER, GATE_DISPLAY_NAMES } from "../quality/registry.js";
import { REVIEW_GATE_REGISTRY } from "../quality/review-gates.js";
import { saveReviewReport } from "../storage/reports.js";

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
    title: "supi:checks",
    statusKey: "supi-review",
    statusLabel: "Running checks...",
    widgetKey: "supi-review",
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
      "Checks cancelled",
      "Removed invalid quality.gates config, but setup was cancelled. Checks did not run.",
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

  const gateNames = failedGates.map((g) => GATE_DISPLAY_NAMES[g.gate] ?? g.gate);
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
  const reviewProgress = createReviewProgress(ctx);

  try {
    const modelCfg = deps.loadModelConfig(platform.paths, ctx.cwd);
    const bridge = deps.createModelBridge(platform);
    const resolved = deps.resolveModelForAction("checks", modelRegistry, modelCfg, bridge);
    await deps.applyModelOverride(platform, ctx, "checks", resolved);

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

    // Dispose widget before showing any TUI dialogs
    reviewProgress.dispose();

    const failedGates = getFailedGates(report);

    if (failedGates.length === 0) {
      deps.notifyInfo(
        ctx,
        `Checks complete: ${report.overallStatus}`,
        buildReviewSummary(report, reportPath),
      );
      return;
    }

    // Show compact failure summary
    const failureNames = failedGates.map((g) => GATE_DISPLAY_NAMES[g.gate] ?? g.gate);
    deps.notifyInfo(
      ctx,
      `Checks complete: ${report.overallStatus}`,
      buildFailureSummary(failedGates),
    );

    // Offer to fix
    const FIX_NOW = `Yes, fix ${failureNames.join(", ")}`;
    const SAVE_ONLY = "No, just save for later";
    const choice = await ctx.ui.select(
      `${failedGates.length} check${failedGates.length === 1 ? "" : "s"} failed — do you want to fix now?`,
      [FIX_NOW, SAVE_ONLY],
    );

    if (choice === FIX_NOW) {
      platform.sendUserMessage(buildFixPrompt(failedGates));
    }
  } catch (error) {
    reviewProgress.failActive((error as Error).message);
    throw error;
  } finally {
    reviewProgress.dispose();
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
