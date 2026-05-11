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
  HarnessValidateCheck,
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
  loadHarnessDesignSpecJson,
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

type CheckContract = Pick<HarnessValidateCheck, "invariant" | "proves" | "doesNotProve" | "artifact" | "failSafe">;

const CHECK_CONTRACTS: Readonly<Record<string, CheckContract>> = {
  "cross-link-check": {
    invariant: "Agent-facing harness docs must exist and point maintainers to the architecture and golden-principles contracts.",
    proves: "AGENTS.md, docs/architecture.md, and docs/golden-principles.md exist, and AGENTS.md references the core docs.",
    doesNotProve: "The docs are semantically complete, current, or sufficient for every agent client.",
    artifact: "validate-report.json findings plus filesystem state",
    failSafe: "Missing or unreadable docs produce error findings and block validation.",
  },
  "schema-check": {
    invariant: "Persisted pipeline artifacts must remain readable before later stages claim continuity.",
    proves: "discover.json can be loaded for the active harness session.",
    doesNotProve: "The discovered facts are fresh or semantically exhaustive.",
    artifact: "validate-report.json schema-check entry",
    failSafe: "Missing or invalid JSON produces an error finding and blocks validation.",
  },
  "discover-drift": {
    invariant: "The saved discovery artifact should not silently diverge from the current repository profile.",
    proves: "A fresh discovery pass did not reveal language-level drift that invalidates the saved artifact.",
    doesNotProve: "Every framework, script, dependency, or architecture convention is unchanged.",
    artifact: "validate-report.json discover-drift entry",
    failSafe: "Missing discovery data blocks; detected drift is recorded as warning/info with remediation.",
  },
  "anti-slop-scan": {
    invariant: "New duplicate, dead-code, and layer-drift findings must be visible in the persistent slop queue.",
    proves: "The selected backend either ran and returned findings, or an explicitly soft-failed optional backend state was recorded.",
    doesNotProve: "The selected backend can detect semantic bugs, product regressions, or unsupported language patterns.",
    artifact: "validate-report.json, queue.jsonl, score.json",
    failSafe: "Missing optional backend configuration warns; backend runtime errors become blocking findings.",
  },
  "synthetic-edit-test": {
    invariant: "Installed anti-slop hooks must fire against a controlled representative edit before the harness claims runtime guardrails work.",
    proves: "The enabled in-process hook handlers respond to the synthetic edit fixture without reported failures.",
    doesNotProve: "Hook latency, all real editor events, or every repository-specific layer edge case.",
    artifact: "validate-report.json synthetic-edit-test entry",
    failSafe: "Hook failures are emitted as error findings and block validation.",
  },
  "ci-local-wiring": {
    invariant: "Every harness validation gate must have one local command and CI must invoke that command instead of relying on human memory.",
    proves: "The configured local command exists and the configured CI workflow calls it on the selected PR trigger.",
    doesNotProve: "The command's inner toolchain is installed, every gate is semantically sufficient, or CI provider secrets/runners are available.",
    artifact: "validate-report.json plus package.json and CI workflow contents",
    failSafe: "Missing package scripts or workflow files emit error findings and block validation.",
  },
};

function attachCheckContract(check: CheckResult): HarnessValidateCheck {
  const contract = CHECK_CONTRACTS[check.name] ?? {
    invariant: `The ${check.name} gate must state the rule it protects.`,
    proves: check.summary,
    doesNotProve: "No explicit blind spot was registered for this check.",
    artifact: "validate-report.json",
    failSafe: "Unknown checks should be given an explicit contract before release.",
  };
  return { ...check, ...contract };
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

function scriptNameFromLocalCommand(command: string): string | null {
  const trimmed = command.trim();
  const runMatch = /^(?:bun|npm|pnpm|yarn)\s+run\s+([^\s]+)$/.exec(trimmed);
  if (runMatch) return runMatch[1];
  const pnpmOrYarnMatch = /^(?:pnpm|yarn)\s+([^\s]+)$/.exec(trimmed);
  if (pnpmOrYarnMatch) return pnpmOrYarnMatch[1];
  return null;
}

/**
 * Conservative check that a GitHub Actions workflow grants the write scope needed for
 * the harness PR comment. Only inspects the `permissions:` block — if a user has wired
 * a deploy token or `secrets.GITHUB_TOKEN` with a custom scope, this returns false and
 * the warning is a no-op false positive. That's deliberate: a false-positive warning is
 * cheaper than a silent 403 the first time CI tries to post.
 *
 * Caveats this regex deliberately does not handle:
 *  - Job-scoped `permissions:` blocks that grant `pull-requests: write` to a job other
 *    than the one running `/supi:harness pr-comment`. Detecting that requires real YAML
 *    parsing; a false-positive warning is again cheaper than guessing wrong.
 */
function workflowGrantsPrCommentPermission(workflow: string): boolean {
  // Strip whole-line YAML comments before matching so a commented-out
  // `# pull-requests: write` does not falsely register as a grant.
  const stripped = workflow.replace(/^[ \t]*#.*$/gm, "");
  // Match either inline mapping `permissions: { pull-requests: write }`, the block form
  // with `pull-requests: write` on its own line, or the broad `permissions: write-all`.
  if (/permissions:\s*write-all\b/.test(stripped)) return true;
  if (/\bpull-requests:\s*write\b/.test(stripped)) return true;
  return false;
}

async function checkCiLocalWiring(
  paths: HarnessStageRunnerContext["paths"],
  cwd: string,
  sessionId: string,
): Promise<CheckResult> {
  const startedAt = Date.now();
  const findings: HarnessValidateFinding[] = [];
  const spec = loadHarnessDesignSpecJson(paths, cwd, sessionId);
  if (!spec.ok) {
    return {
      name: "ci-local-wiring",
      passed: true,
      summary: "Skipped: no design-spec.json available for CI wiring validation.",
      findings,
      durationMs: Date.now() - startedAt,
    };
  }

  if (!spec.value.ci) {
    return {
      name: "ci-local-wiring",
      passed: false,
      summary: "design-spec.json does not contain CI/local wiring configuration.",
      findings: [{
        severity: "error",
        file: "design-spec.json",
        message: "Design spec is missing ci configuration.",
        remediation: "Re-run /supi:harness design so CI trigger and local quality command are recorded.",
        source: "ci-local-wiring",
      }],
      durationMs: Date.now() - startedAt,
    };
  }


  const scriptName = scriptNameFromLocalCommand(spec.value.ci.localCommand);
  const packageJsonPath = path.join(cwd, "package.json");
  if (scriptName) {
    if (!fs.existsSync(packageJsonPath)) {
      findings.push({
        severity: "error",
        file: "package.json",
        message: `Local quality command ${spec.value.ci.localCommand} requires package.json, but package.json is missing.`,
        remediation: `Create package.json with a scripts.${scriptName} entry or choose a non-package local command.`,
        source: "ci-local-wiring",
      });
    } else {
      try {
        const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { scripts?: Record<string, unknown> };
        if (typeof parsed.scripts?.[scriptName] !== "string") {
          findings.push({
            severity: "error",
            file: "package.json",
            message: `package.json does not define scripts.${scriptName} for ${spec.value.ci.localCommand}.`,
            remediation: `Add scripts.${scriptName} and make it run the validation gates from design-spec.json.`,
            source: "ci-local-wiring",
          });
        }
      } catch (error) {
        findings.push({
          severity: "error",
          file: "package.json",
          message: `package.json is unreadable or invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
          remediation: "Fix package.json before validating CI/local quality wiring.",
          source: "ci-local-wiring",
        });
      }
    }
  }

  const workflowPath = path.join(cwd, spec.value.ci.workflowPath);
  if (!fs.existsSync(workflowPath)) {
    findings.push({
      severity: "error",
      file: spec.value.ci.workflowPath,
      message: `CI workflow ${spec.value.ci.workflowPath} is missing.`,
      remediation: `Create the workflow and have it run ${spec.value.ci.localCommand}.`,
      source: "ci-local-wiring",
    });
  } else {
    try {
      const workflow = fs.readFileSync(workflowPath, "utf8");
      if (!workflow.includes(spec.value.ci.localCommand)) {
        findings.push({
          severity: "error",
          file: spec.value.ci.workflowPath,
          message: `CI workflow does not invoke ${spec.value.ci.localCommand}.`,
          remediation: "Call the local harness quality command from CI instead of duplicating gate commands inline.",
          source: "ci-local-wiring",
        });
      }
      if (spec.value.ci.trigger.mode === "branches") {
        for (const branch of spec.value.ci.trigger.branches) {
          if (!workflow.includes(branch)) {
            findings.push({
              severity: "error",
              file: spec.value.ci.workflowPath,
              message: `CI workflow does not mention configured PR target branch ${branch}.`,
              remediation: `Add ${branch} to the pull_request.branches trigger or update the design spec.`,
              source: "ci-local-wiring",
            });
          }
        }
      }
      // Informational: when prComment is enabled but the workflow lacks
      // `pull-requests: write`, the `gh api` upsert will fail with 403. Surface a warning
      // so the user notices before the first failed PR run.
      if (spec.value.ci.prComment?.enabled && !workflowGrantsPrCommentPermission(workflow)) {
        findings.push({
          severity: "warning",
          file: spec.value.ci.workflowPath,
          message: "CI workflow does not grant `pull-requests: write` but prComment.enabled is true.",
          remediation: "Add `permissions: { pull-requests: write }` to the workflow so /supi:harness pr-comment can post.",
          source: "ci-local-wiring",
        });
      }
    } catch (error) {
      findings.push({
        severity: "error",
        file: spec.value.ci.workflowPath,
        message: `CI workflow is unreadable: ${error instanceof Error ? error.message : String(error)}`,
        remediation: "Fix workflow file permissions or contents.",
        source: "ci-local-wiring",
      });
    }
  }

  return {
    name: "ci-local-wiring",
    passed: !findings.some((finding) => finding.severity === "error"),
    summary: findings.length === 0
      ? "CI workflow invokes the local harness quality command."
      : `${findings.length} CI/local wiring issue(s) detected.`,
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
  checks.push(await checkCiLocalWiring(ctx.paths, ctx.cwd, ctx.sessionId));

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
    checks: checks.map(attachCheckContract),
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
