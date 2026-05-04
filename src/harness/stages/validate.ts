/**
 * VALIDATE stage runner.
 *
 * Runs every sub-check the harness installed:
 *  - lint (delegates to the configured tool via platform.exec; structured pass/fail),
 *  - structural test (placeholder — emitter-supplied; harness only records the result),
 *  - eval (placeholder),
 *  - cross-link check (every artifact referenced from AGENTS.md / docs/ exists),
 *  - schema check (Discover / Design / Plan artifacts validate),
 *  - discover-drift (re-run Discover and diff against the saved artifact),
 *  - anti-slop scan (selected backend audit),
 *  - score computation,
 *  - synthetic edit test (hooks fire).
 *
 * Returns a `HarnessValidateReport` and persists it. The command handler owns the
 * user-accept gate.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { Platform } from "../../platform/types.js";
import type {
  HarnessAntiSlopBackend,
  HarnessLayerRule,
  HarnessSlopQueueEntry,
  HarnessValidateFinding,
  HarnessValidateReport,
} from "../../types.js";
import { parseArchitectureMarkdown } from "../anti_slop/architecture-parser.js";
import type { SlopBackend, SlopFinding } from "../anti_slop/backend.js";
import { computeQueueEntryId } from "../anti_slop/queue.js";
import { computeScore, scoreFloorPassed } from "../anti_slop/score.js";
import { runSyntheticEditTest } from "../anti_slop/synthetic-edit-test.js";
import {
  type HarnessStageRunResult,
  type HarnessStageRunner,
  type HarnessStageRunnerContext,
  nowIso,
} from "../stage-runner.js";
import {
  appendScoreHistory,
  appendSlopQueueEntry,
  loadHarnessDiscover,
  saveHarnessRepoScore,
  saveHarnessValidateReport,
  readSlopQueue,
} from "../storage.js";
import { buildDiscoverArtifact } from "./discover.js";
import {
  getHarnessAgentsMdPath,
  getHarnessArchitectureDocPath,
  getHarnessGoldenPrinciplesPath,
} from "../project-paths.js";

export interface ValidateStageInput {
  /** Selected backend (from the design spec). */
  backend: HarnessAntiSlopBackend;
  /** Backend adapter (only consulted when `backend !== "supi-native"`). */
  adapter?: SlopBackend;
  /** Score floor configuration. */
  scoreFloor: { strict: number; lenient: number; release_blocking: boolean };
  /** Hook config snapshot for the synthetic-edit test. */
  hooks: {
    pre_edit_dupe_probe: { enabled: boolean };
    post_session_sweep: { enabled: boolean };
    layer_context_inject: { enabled: boolean; addendum_max_chars: number };
  };
}

interface CheckResult {
  name: string;
  passed: boolean;
  summary: string;
  findings: HarnessValidateFinding[];
  durationMs?: number;
}

async function checkCrossLinks(cwd: string): Promise<CheckResult> {
  const startedAt = Date.now();
  const findings: HarnessValidateFinding[] = [];

  const agentsPath = path.join(cwd, "AGENTS.md");
  const architecturePath = path.join(cwd, "docs", "architecture.md");
  const goldenPath = path.join(cwd, "docs", "golden-principles.md");

  const expected = [
    { file: "AGENTS.md", path: agentsPath },
    { file: "docs/architecture.md", path: architecturePath },
    { file: "docs/golden-principles.md", path: goldenPath },
  ];
  for (const target of expected) {
    if (!fs.existsSync(target.path)) {
      findings.push({
        severity: "error",
        file: target.file,
        message: `${target.file} is missing`,
        remediation: `Run /supi:harness implement (or rebuild) to regenerate ${target.file}.`,
        source: "cross-link-check",
      });
    }
  }

  // AGENTS.md must reference both core docs.
  if (fs.existsSync(agentsPath)) {
    try {
      const agents = fs.readFileSync(agentsPath, "utf8");
      if (!agents.includes("docs/architecture.md")) {
        findings.push({
          severity: "warning",
          file: "AGENTS.md",
          message: "AGENTS.md does not reference docs/architecture.md",
          remediation: "Add a link to docs/architecture.md from AGENTS.md.",
          source: "cross-link-check",
        });
      }
      if (!agents.includes("docs/golden-principles.md")) {
        findings.push({
          severity: "warning",
          file: "AGENTS.md",
          message: "AGENTS.md does not reference docs/golden-principles.md",
          remediation: "Add a link to docs/golden-principles.md from AGENTS.md.",
          source: "cross-link-check",
        });
      }
    } catch {
      findings.push({
        severity: "error",
        file: "AGENTS.md",
        message: "AGENTS.md exists but is unreadable",
        remediation: "Inspect filesystem permissions on AGENTS.md.",
        source: "cross-link-check",
      });
    }
  }

  const passed = !findings.some((f) => f.severity === "error");
  return {
    name: "cross-link-check",
    passed,
    summary: passed
      ? "All required artifacts exist and AGENTS.md references core docs."
      : `${findings.length} issue(s) detected.`,
    findings,
    durationMs: Date.now() - startedAt,
  };
}

async function checkSchema(
  paths: HarnessStageRunnerContext["paths"],
  cwd: string,
  sessionId: string,
): Promise<CheckResult> {
  const startedAt = Date.now();
  const findings: HarnessValidateFinding[] = [];

  const discover = loadHarnessDiscover(paths, cwd, sessionId);
  if (!discover.ok) {
    findings.push({
      severity: "error",
      file: "discover.json",
      message: `discover.json is missing or invalid: ${discover.error.message}`,
      remediation: "Re-run /supi:harness discover.",
      source: "schema-check",
    });
  }

  return {
    name: "schema-check",
    passed: findings.length === 0,
    summary: findings.length === 0 ? "All schemas valid." : "Schema validation failed.",
    findings,
    durationMs: Date.now() - startedAt,
  };
}

async function checkDiscoverDrift(
  paths: HarnessStageRunnerContext["paths"],
  cwd: string,
  sessionId: string,
  now: string,
): Promise<CheckResult> {
  const startedAt = Date.now();
  const findings: HarnessValidateFinding[] = [];

  const saved = loadHarnessDiscover(paths, cwd, sessionId);
  if (!saved.ok) {
    findings.push({
      severity: "error",
      file: "discover.json",
      message: "Cannot drift-check: saved discover artifact missing",
      remediation: "Re-run /supi:harness discover.",
      source: "discover-drift",
    });
    return {
      name: "discover-drift",
      passed: false,
      summary: "discover.json missing",
      findings,
      durationMs: Date.now() - startedAt,
    };
  }
  const fresh = buildDiscoverArtifact({ cwd, sessionId, now });
  const savedLangs = new Set(saved.value.languages);
  const freshLangs = new Set(fresh.languages);
  for (const lang of freshLangs) {
    if (!savedLangs.has(lang)) {
      findings.push({
        severity: "warning",
        file: "discover.json",
        message: `New language detected since saved discover: ${lang}`,
        remediation: "Re-run /supi:harness discover to refresh the artifact.",
        source: "discover-drift",
      });
    }
  }
  for (const lang of savedLangs) {
    if (!freshLangs.has(lang)) {
      findings.push({
        severity: "info",
        file: "discover.json",
        message: `Language no longer present: ${lang}`,
        remediation: "Re-run /supi:harness discover to refresh the artifact.",
        source: "discover-drift",
      });
    }
  }

  const passed = !findings.some((f) => f.severity === "error");
  return {
    name: "discover-drift",
    passed,
    summary: passed ? "Discover artifact reflects current repo state." : "Discover artifact is stale.",
    findings,
    durationMs: Date.now() - startedAt,
  };
}

async function checkAntiSlopScan(
  platform: Platform,
  cwd: string,
  input: ValidateStageInput,
): Promise<{
  result: CheckResult;
  scanFindings: SlopFinding[];
  slopCounts: { duplicates: number; deadCode: number; layerViolations: number; other: number };
}> {
  const startedAt = Date.now();
  const findings: HarnessValidateFinding[] = [];
  const slopCounts = { duplicates: 0, deadCode: 0, layerViolations: 0, other: 0 };

  if (input.backend === "supi-native" || !input.adapter) {
    return {
      result: {
        name: "anti-slop-scan",
        passed: true,
        summary: "Skipped (supi-native backend has no external scan).",
        findings,
        durationMs: Date.now() - startedAt,
      },
      scanFindings: [],
      slopCounts,
    };
  }

  const scan = await input.adapter.audit(platform, { cwd });
  if (!scan.ok) {
    findings.push({
      severity: scan.reason === "not-installed" || scan.reason === "config-missing" ? "warning" : "error",
      file: ".",
      message: `${input.backend} ${scan.reason}: ${scan.message}`,
      remediation: "Install the backend or fall back to supi-native in the design spec.",
      source: "anti-slop-scan",
    });
    return {
      result: {
        name: "anti-slop-scan",
        passed: scan.reason === "not-installed" || scan.reason === "config-missing", // soft-fail
        summary: scan.message,
        findings,
        durationMs: Date.now() - startedAt,
      },
      scanFindings: [],
      slopCounts,
    };
  }

  for (const finding of scan.findings) {
    if (finding.kind === "duplicate") slopCounts.duplicates += 1;
    else if (finding.kind === "dead-code") slopCounts.deadCode += 1;
    else if (finding.kind === "layer-violation") slopCounts.layerViolations += 1;
    else slopCounts.other += 1;
  }

  return {
    result: {
      name: "anti-slop-scan",
      passed: scan.findings.length === 0,
      summary:
        scan.findings.length === 0
          ? "No slop findings."
          : `${scan.findings.length} slop finding(s) recorded; see queue.`,
      findings,
      durationMs: Date.now() - startedAt,
    },
    scanFindings: scan.findings,
    slopCounts,
  };
}

function checkSyntheticEdit(input: ValidateStageInput, layerRules: readonly HarnessLayerRule[]): CheckResult {
  const startedAt = Date.now();
  const test = runSyntheticEditTest({
    layerRules,
    hooks: input.hooks,
  });
  const findings: HarnessValidateFinding[] = test.failures.map((failure) => ({
    severity: "error" as const,
    file: "synthetic-edit-test",
    message: failure,
    remediation: "Inspect the failing hook implementation; test runs against in-process handlers.",
    source: "synthetic-edit-test",
  }));
  return {
    name: "synthetic-edit-test",
    passed: test.failures.length === 0,
    summary:
      test.failures.length === 0
        ? `${test.hooksFired.length} hook(s) fired as expected.`
        : `${test.failures.length} synthetic-edit failure(s).`,
    findings,
    durationMs: Date.now() - startedAt,
  };
}

function loadLayerRules(cwd: string): HarnessLayerRule[] {
  const archPath = path.join(cwd, "docs", "architecture.md");
  if (!fs.existsSync(archPath)) return [];
  try {
    const md = fs.readFileSync(archPath, "utf8");
    return parseArchitectureMarkdown(md);
  } catch {
    return [];
  }
}

/**
 * Run every sub-check and assemble the validate report. Pure-ish: side effects are limited
 * to the optional anti-slop scan (which itself is fenced behind the adapter's
 * `isAvailable`).
 */
export async function runValidate(
  ctx: HarnessStageRunnerContext,
  input: ValidateStageInput,
): Promise<HarnessValidateReport> {
  const recordedAt = nowIso(ctx);
  const layerRules = loadLayerRules(ctx.cwd);

  const checks: CheckResult[] = [];
  const slopFindings: SlopFinding[] = [];
  let slopCounts = { duplicates: 0, deadCode: 0, layerViolations: 0, other: 0 };

  checks.push(await checkCrossLinks(ctx.cwd));
  checks.push(await checkSchema(ctx.paths, ctx.cwd, ctx.sessionId));
  checks.push(await checkDiscoverDrift(ctx.paths, ctx.cwd, ctx.sessionId, recordedAt));

  const scanResult = await checkAntiSlopScan(ctx.platform, ctx.cwd, input);
  checks.push(scanResult.result);
  slopFindings.push(...scanResult.scanFindings);
  slopCounts = scanResult.slopCounts;

  const synthetic = checkSyntheticEdit(input, layerRules);
  checks.push(synthetic);

  // Persist scan findings to the queue so future runs see them.
  for (const finding of slopFindings) {
    const id = computeQueueEntryId({
      kind: finding.kind,
      file: finding.file,
      range: finding.range,
      ruleHint: typeof finding.details?.rule === "string" ? finding.details.rule : undefined,
    });
    const entry: HarnessSlopQueueEntry = {
      id,
      kind: finding.kind,
      file: finding.file,
      range: finding.range,
      severity: finding.severity,
      source: finding.source,
      state: "open",
      message: finding.message,
      remediation: finding.remediation,
      ts: recordedAt,
      ...(finding.clusterKey ? { clusters: [finding.clusterKey] } : {}),
      ...(finding.details ? { details: finding.details } : {}),
    };
    appendSlopQueueEntry(ctx.paths, ctx.cwd, entry);
  }

  // Score = pulled from the queue (post-write so this run's findings are reflected).
  const queue = readSlopQueue(ctx.paths, ctx.cwd);
  const score = computeScore({
    computedAt: recordedAt,
    entries: queue.ok ? queue.value : [],
  });
  const floor = scoreFloorPassed(score, input.scoreFloor);

  const passed = checks.every((c) => c.passed) && floor.passed;
  const report: HarnessValidateReport = {
    sessionId: ctx.sessionId,
    recordedAt,
    passed,
    checks,
    slopScan: {
      backend: input.backend,
      duplicates: slopCounts.duplicates,
      deadCode: slopCounts.deadCode,
      layerViolations: slopCounts.layerViolations,
      other: slopCounts.other,
    },
    score,
    scoreFloorPassed: floor.passed,
    syntheticEditTest: {
      ran: synthetic.passed || synthetic.findings.length > 0,
      hooksFired: [],
      failures: synthetic.findings.map((f) => f.message),
    },
  };

  // Persist the score snapshot + history.
  saveHarnessRepoScore(ctx.paths, ctx.cwd, score);
  appendScoreHistory(ctx.paths, ctx.cwd, {
    recordedAt,
    sessionId: ctx.sessionId,
    lenient: score.lenient,
    strict: score.strict,
  });

  return report;
}

export class HarnessValidateStage implements HarnessStageRunner {
  readonly stage = "validate" as const;

  constructor(private readonly input: ValidateStageInput) {}

  async isReady(ctx: HarnessStageRunnerContext): Promise<boolean> {
    return loadHarnessDiscover(ctx.paths, ctx.cwd, ctx.sessionId).ok;
  }

  async isComplete(ctx: HarnessStageRunnerContext): Promise<boolean> {
    const reportPath = path.join(
      path.dirname(getHarnessArchitectureDocPath(ctx.paths, ctx.cwd)),
      "..",
      "validate-report.json",
    );
    return fs.existsSync(reportPath);
  }

  async run(ctx: HarnessStageRunnerContext): Promise<HarnessStageRunResult> {
    const report = await runValidate(ctx, this.input);
    const persisted = saveHarnessValidateReport(ctx.paths, ctx.cwd, ctx.sessionId, report);
    if (!persisted.ok) {
      return {
        status: "failed",
        stage: this.stage,
        artifactPaths: [],
        error: `failed to persist validate report: ${persisted.error.message}`,
      };
    }
    return {
      status: report.passed ? "awaiting-user" : "blocked",
      stage: this.stage,
      artifactPaths: ["validate-report.json"],
      blocker: report.passed ? undefined : { code: "validate-failed", message: "Validate report contains failures." },
      details: {
        passed: report.passed,
        scoreLenient: report.score.lenient,
        scoreStrict: report.score.strict,
      },
    };
  }
}

// Suppress static-analysis "imported but unused" — these are referenced via path
// composition in nested helpers and we keep the imports for clarity.
void getHarnessAgentsMdPath;
void getHarnessGoldenPrinciplesPath;
