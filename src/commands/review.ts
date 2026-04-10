import type { Platform } from "../platform/types.js";
import { loadConfig } from "../config/loader.js";
import { notifyInfo } from "../notifications/renderer.js";
import { modelRegistry } from "../config/model-registry-instance.js";
import { resolveModelForAction, createModelBridge, applyModelOverride } from "../config/model-resolver.js";
import { loadModelConfig } from "../config/model-config.js";
import { runQualityGates } from "../quality/runner.js";
import type { GateFilters, GateId, QualityGatesConfig, ReviewReport } from "../types.js";
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

export interface ReviewCommandDependencies {
  loadModelConfig: typeof loadModelConfig;
  createModelBridge: typeof createModelBridge;
  resolveModelForAction: typeof resolveModelForAction;
  applyModelOverride: typeof applyModelOverride;
  loadConfig: typeof loadConfig;
  runQualityGates: typeof runQualityGates;
  saveReviewReport: typeof saveReviewReport;
  notifyInfo: typeof notifyInfo;
}

const REVIEW_COMMAND_DEPENDENCIES: ReviewCommandDependencies = {
  loadModelConfig,
  createModelBridge,
  resolveModelForAction,
  applyModelOverride,
  loadConfig,
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
  const modelCfg = deps.loadModelConfig(platform.paths, ctx.cwd);
  const bridge = deps.createModelBridge(platform);
  const resolved = deps.resolveModelForAction("review", modelRegistry, modelCfg, bridge);
  await deps.applyModelOverride(platform, ctx, "review", resolved);

  const config = deps.loadConfig(platform.paths, ctx.cwd);
  const enabledGateIds = getEnabledGateIds(config.quality.gates);
  const filters = parseGateFilters(args);
  validateGateSelection(enabledGateIds, filters);

  const report = await deps.runQualityGates({
    platform,
    cwd: ctx.cwd,
    gates: config.quality.gates,
    filters,
    reviewModel: resolved,
    gateRegistry: REVIEW_GATE_REGISTRY,
  });
  const reportPath = deps.saveReviewReport(platform.paths, ctx.cwd, report);

  deps.notifyInfo(
    ctx,
    `Review complete: ${report.overallStatus}`,
    buildReviewSummary(report, reportPath),
  );
}

export function registerReviewCommand(platform: Platform): void {
  platform.registerCommand("supi:review", {
    description: "Run configured quality gates",
    async handler(args: string | undefined, ctx: any) {
      await handleReview(platform, ctx, args);
    },
  });
}
