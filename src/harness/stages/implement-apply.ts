/**
 * IMPLEMENT stage — programmatic apply.
 *
 * Single deterministic pass that materializes every Tier 1 artifact from the design spec.
 * Replaces the previous agent-handoff model: the harness now writes its own outputs the
 * same way `/supi:checks` runs its gates, so a single `/supi:harness` invocation drives
 * discover → research → design → plan → implement → docs → validate end-to-end.
 *
 * Every applier is idempotent: rerunning over an already-installed repo compares existing
 * content to the desired bytes and reports `"skipped"`. Side-effecting installers (fallow,
 * desloppify) inherit the apply/skip contract from `anti_slop/installer.ts`.
 *
 * Failures are aggregated and returned alongside the partial result so the stage runner
 * can surface a structured blocker without losing track of what already landed.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { Platform, PlatformPaths } from "../../platform/types.js";
import type {
  HarnessAntiSlopBackend,
  HarnessDesignSpec,
  HarnessSlopQueueEntry,
} from "../../types.js";
import { renderAgentsMd } from "../artifacts/agents-md.js";
import {
  renderArchitectureMd,
  renderGoldenPrinciplesMd,
} from "../artifacts/docs-tree.js";
import { renderHarnessArchitectureReviewAgent } from "../artifacts/review-agents.js";
import {
  renderEvalConfig,
  renderLintConfig,
  renderStructuralTestConfig,
} from "../artifacts/lint-configs.js";
import { buildChecksWiringPatch } from "../artifacts/checks-wiring.js";
import { writeMarker } from "../bare-entry.js";
import { computeScore } from "../anti_slop/score.js";
import {
  ensureDesloppifyGitignore,
  installFallow,
  distributeAgentSkills,
} from "../anti_slop/installer.js";
import { readSlopQueue, saveHarnessRepoScore } from "../storage.js";
import {
  getHarnessAgentsMdPath,
  getHarnessArchitectureDocPath,
  getHarnessGoldenPrinciplesPath,
  getHarnessQueuePath,
  getHarnessRepoLocalDir,
} from "../project-paths.js";
import { getLocalStatePath } from "../../workspace/state-paths.js";

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

export interface ApplyHarnessPlanInput {
  platform: Platform;
  paths: PlatformPaths;
  cwd: string;
  spec: HarnessDesignSpec;
  /** When false, every applier reports what *would* happen without touching disk. */
  apply?: boolean;
}

export type ApplyAction = "wrote" | "skipped" | "patched" | "noop";

export interface ApplyResult {
  step: string;
  path: string;
  action: ApplyAction;
  detail?: string;
}

export interface ApplyError {
  step: string;
  message: string;
}

export interface ApplyOutcome {
  applied: ApplyResult[];
  warnings: string[];
  errors: ApplyError[];
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

/**
 * Apply every Tier 1 artifact described by the design spec. The set of artifacts mirrors
 * `buildHarnessPlanTasks(spec)` exactly so the rendered plan and the actual file actions
 * stay in lock-step.
 *
 * The function never throws on a single applier failure — failures are captured in
 * `errors[]` and the rest of the pipeline continues so a broken anti-slop install does
 * not stop the docs from landing. The caller (stage runner) decides whether to surface
 * the aggregated `errors` as a blocker.
 */
export async function applyHarnessPlan(
  input: ApplyHarnessPlanInput,
): Promise<ApplyOutcome> {
  const apply = input.apply !== false;
  const outcome: ApplyOutcome = { applied: [], warnings: [], errors: [] };

  const steps: Array<() => Promise<void> | void> = [
    () => applyArchitectureDoc(input, outcome, apply),
    () => applyGoldenPrinciplesDoc(input, outcome, apply),
    () => applyLintConfig(input, outcome, apply),
    () => applyStructuralTestConfig(input, outcome, apply),
    () => applyEvalConfig(input, outcome, apply),
    () => applyPackageJsonScript(input, outcome, apply),
    () => applyCiWorkflow(input, outcome, apply),
    () => applyAntiSlopBackend(input, outcome, apply),
    () => applyHarnessMarker(input, outcome, apply),
    () => applySlopQueueInit(input, outcome, apply),
    () => applyScorecardSkeleton(input, outcome, apply),
    () => applyReviewAgent(input, outcome, apply),
    () => applyChecksGateWiring(input, outcome, apply),
    () => applyAgentsMd(input, outcome, apply),
  ];

  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      outcome.errors.push({
        step: "(unhandled)",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return outcome;
}

// ---------------------------------------------------------------------------
// Generic write helpers.
// ---------------------------------------------------------------------------

interface DesiredFile {
  step: string;
  absPath: string;
  /** Repo-relative or canonical path used in the result + audit log. */
  reportPath: string;
  contents: string;
}

function writeIfChanged(
  desired: DesiredFile,
  apply: boolean,
  outcome: ApplyOutcome,
): void {
  let existing: string | null = null;
  if (fs.existsSync(desired.absPath)) {
    try {
      existing = fs.readFileSync(desired.absPath, "utf8");
    } catch (error) {
      outcome.warnings.push(
        `${desired.step}: unable to read existing ${desired.reportPath}: ${describe(error)}`,
      );
    }
  }

  if (existing === desired.contents) {
    outcome.applied.push({
      step: desired.step,
      path: desired.reportPath,
      action: "skipped",
      detail: "up-to-date",
    });
    return;
  }

  if (!apply) {
    outcome.applied.push({
      step: desired.step,
      path: desired.reportPath,
      action: "noop",
      detail: existing === null ? "would create" : "would update",
    });
    return;
  }

  try {
    fs.mkdirSync(path.dirname(desired.absPath), { recursive: true });
    fs.writeFileSync(desired.absPath, desired.contents);
    outcome.applied.push({
      step: desired.step,
      path: desired.reportPath,
      action: "wrote",
      detail: existing === null ? "created" : "updated",
    });
  } catch (error) {
    outcome.errors.push({
      step: desired.step,
      message: `failed to write ${desired.reportPath}: ${describe(error)}`,
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function repoRelative(cwd: string, absPath: string): string {
  const rel = path.relative(cwd, absPath);
  return rel.split(path.sep).join("/");
}

// ---------------------------------------------------------------------------
// Per-task appliers.
// ---------------------------------------------------------------------------

function applyArchitectureDoc(
  input: ApplyHarnessPlanInput,
  outcome: ApplyOutcome,
  apply: boolean,
): void {
  const absPath = getHarnessArchitectureDocPath(input.paths, input.cwd);
  writeIfChanged(
    {
      step: "Write docs/architecture.md",
      absPath,
      reportPath: repoRelative(input.cwd, absPath),
      contents: renderArchitectureMd({ spec: input.spec }),
    },
    apply,
    outcome,
  );
}

function applyGoldenPrinciplesDoc(
  input: ApplyHarnessPlanInput,
  outcome: ApplyOutcome,
  apply: boolean,
): void {
  const absPath = getHarnessGoldenPrinciplesPath(input.paths, input.cwd);
  writeIfChanged(
    {
      step: "Write docs/golden-principles.md",
      absPath,
      reportPath: repoRelative(input.cwd, absPath),
      contents: renderGoldenPrinciplesMd({ spec: input.spec }),
    },
    apply,
    outcome,
  );
}

function applyLintConfig(
  input: ApplyHarnessPlanInput,
  outcome: ApplyOutcome,
  apply: boolean,
): void {
  const tool = input.spec.tooling.lint;
  if (!tool) return;
  const rendered = renderLintConfig({ tool, languages: [] });
  if (!rendered) {
    outcome.warnings.push(
      `lint tool "${tool}" has no canonical template; skipping config emit. Run /supi:harness design to pick a supported tool.`,
    );
    return;
  }
  const absPath = path.join(input.cwd, rendered.filename);
  writeIfChanged(
    {
      step: `Wire lint tool (${tool})`,
      absPath,
      reportPath: rendered.filename,
      contents: rendered.content,
    },
    apply,
    outcome,
  );
}

function applyStructuralTestConfig(
  input: ApplyHarnessPlanInput,
  outcome: ApplyOutcome,
  apply: boolean,
): void {
  const tool = input.spec.tooling.structuralTest;
  if (!tool) return;
  const rendered = renderStructuralTestConfig({ tool });
  if (!rendered) {
    outcome.warnings.push(
      `structural-test tool "${tool}" has no canonical template; skipping config emit.`,
    );
    return;
  }
  const absPath = path.join(input.cwd, rendered.filename);
  writeIfChanged(
    {
      step: `Wire structural test tool (${tool})`,
      absPath,
      reportPath: rendered.filename,
      contents: rendered.content,
    },
    apply,
    outcome,
  );
}

function applyEvalConfig(
  input: ApplyHarnessPlanInput,
  outcome: ApplyOutcome,
  apply: boolean,
): void {
  const tool = input.spec.tooling.eval;
  if (!tool) return;
  const rendered = renderEvalConfig({ tool });
  if (!rendered) {
    outcome.warnings.push(
      `eval tool "${tool}" has no canonical template; skipping config emit.`,
    );
    return;
  }
  const absPath = path.join(input.cwd, rendered.filename);
  writeIfChanged(
    {
      step: `Wire eval framework (${tool})`,
      absPath,
      reportPath: rendered.filename,
      contents: rendered.content,
    },
    apply,
    outcome,
  );
}

/**
 * Extract the npm-script name from a `bun run X` / `npm run X` / `pnpm X` / `yarn X`
 * command. Mirrors the parser in validate.ts so the wiring + the validator agree on what
 * counts as a wired script.
 */
function scriptNameFromLocalCommand(command: string): string | null {
  const trimmed = command.trim();
  const runMatch = /^(?:bun|npm|pnpm|yarn)\s+run\s+([^\s]+)$/.exec(trimmed);
  if (runMatch) return runMatch[1];
  const pnpmOrYarnMatch = /^(?:pnpm|yarn)\s+([^\s]+)$/.exec(trimmed);
  if (pnpmOrYarnMatch) return pnpmOrYarnMatch[1];
  return null;
}

function applyPackageJsonScript(
  input: ApplyHarnessPlanInput,
  outcome: ApplyOutcome,
  apply: boolean,
): void {
  const step = "Wire local harness quality command";
  const scriptName = scriptNameFromLocalCommand(input.spec.ci.localCommand);
  if (!scriptName) {
    outcome.warnings.push(
      `${step}: local command "${input.spec.ci.localCommand}" is not a package-script invocation; skipping package.json wiring.`,
    );
    return;
  }
  const packageJsonPath = path.join(input.cwd, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    outcome.warnings.push(
      `${step}: package.json not found at repo root; cannot wire script "${scriptName}".`,
    );
    return;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(packageJsonPath, "utf8");
  } catch (error) {
    outcome.errors.push({ step, message: `unable to read package.json: ${describe(error)}` });
    return;
  }
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    outcome.errors.push({ step, message: `package.json is invalid JSON: ${describe(error)}` });
    return;
  }

  const scripts = (pkg.scripts && typeof pkg.scripts === "object"
    ? { ...(pkg.scripts as Record<string, unknown>) }
    : {}) as Record<string, unknown>;
  const desired = buildHarnessQualityScript(input.spec);
  if (scripts[scriptName] === desired) {
    outcome.applied.push({
      step,
      path: "package.json",
      action: "skipped",
      detail: `scripts.${scriptName} already wired`,
    });
    return;
  }
  if (!apply) {
    outcome.applied.push({
      step,
      path: "package.json",
      action: "noop",
      detail: `would set scripts.${scriptName}`,
    });
    return;
  }
  scripts[scriptName] = desired;
  const next = { ...pkg, scripts };
  const indent = detectJsonIndent(raw);
  const serialized = `${JSON.stringify(next, null, indent)}\n`;
  try {
    fs.writeFileSync(packageJsonPath, serialized);
    outcome.applied.push({
      step,
      path: "package.json",
      action: "patched",
      detail: `set scripts.${scriptName}`,
    });
  } catch (error) {
    outcome.errors.push({ step, message: `failed to write package.json: ${describe(error)}` });
  }
}

/**
 * The harness quality command runs lint + structural-test + eval gates if configured.
 * Each one is best-effort: a missing tool produces a single-line warning, not a hard fail.
 */
function buildHarnessQualityScript(spec: HarnessDesignSpec): string {
  const parts: string[] = [];
  if (spec.tooling.lint) parts.push(`${spec.tooling.lint} .`);
  if (spec.tooling.structuralTest) parts.push(spec.tooling.structuralTest);
  if (spec.tooling.eval) parts.push(spec.tooling.eval);
  if (parts.length === 0) {
    return "echo 'harness:quality has no gates configured; edit design-spec.json to add tooling.'";
  }
  return parts.join(" && ");
}

function detectJsonIndent(raw: string): number {
  const match = /^\{\s*\n([ \t]+)/.exec(raw);
  if (!match) return 2;
  const ws = match[1];
  if (ws.startsWith("\t")) return 2; // bun's JSON.stringify uses spaces; keep that.
  return ws.length || 2;
}

function applyCiWorkflow(
  input: ApplyHarnessPlanInput,
  outcome: ApplyOutcome,
  apply: boolean,
): void {
  const step = "Wire CI harness quality workflow";
  const workflowRel = input.spec.ci.workflowPath;
  if (input.spec.ci.provider !== "github-actions") {
    outcome.warnings.push(
      `${step}: provider "${input.spec.ci.provider}" has no canonical workflow template; skipping CI workflow emit.`,
    );
    return;
  }
  const absPath = path.join(input.cwd, workflowRel);
  const content = renderGithubActionsWorkflow(input.spec);
  writeIfChanged(
    {
      step,
      absPath,
      reportPath: workflowRel,
      contents: content,
    },
    apply,
    outcome,
  );
}

/**
 * Literal Actions expression `${{ github.event.pull_request.head.ref }}`. Hoisted as a
 * named constant because the inline `${"${{ ... }}"}` form (TS template literal escaping
 * a YAML expression) reads as a typo at the call site.
 */
const PR_HEAD_REF_EXPR = "${{ github.event.pull_request.head.ref }}";

function renderGithubActionsWorkflow(spec: HarnessDesignSpec): string {
  const trigger = spec.ci.trigger;
  // Defense in depth: when the PR-source guardrail is on, force `mainBranch` into the
  // trigger's branch list at render time even if the persisted spec was hand-edited and
  // omits it. Without this, the `verify-pr-source` job below is dead code on PRs into
  // main (the workflow never fires). `runGitVerificationStep` widens the set at capture
  // time too — this is the symmetrical render-time guard.
  const renderBranches = (() => {
    if (trigger.mode !== "branches") return null;
    if (!shouldRenderPrSourceGuardrail(spec)) return trigger.branches;
    const git = spec.ci.git!;
    const merged = new Set(trigger.branches);
    merged.add(git.mainBranch);
    if (git.devBranch) merged.add(git.devBranch);
    return Array.from(merged);
  })();
  const onBlock = trigger.mode === "all-prs"
    ? ["on:", "  pull_request:", "    branches: ['**']"]
    : ["on:", "  pull_request:", `    branches: [${renderBranches!.map((b) => `'${b}'`).join(", ")}]`];
  const setupNode = [
    "      - uses: actions/checkout@v4",
    "      - uses: oven-sh/setup-bun@v2",
    "        with:",
    "          bun-version: latest",
  ];
  const installStep = "      - run: bun install";
  const runStep = `      - run: ${spec.ci.localCommand}`;
  const lines: string[] = [
    "# Generated by /supi:harness.",
    "name: Harness Quality",
    ...onBlock,
    "permissions:",
    "  contents: read",
    "  pull-requests: write",
    "jobs:",
    "  harness-quality:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    ...setupNode,
    installStep,
    runStep,
  ];

  // PR-source guardrail: when the design recorded a dev branch and asked us to enforce
  // "main only accepts PRs from dev", append a deterministic job that fails the PR
  // check whenever a PR targets main from a branch other than dev. This is the
  // workflow-side complement to the optional GitHub ruleset (which the user may not
  // have permission to install) — together they provide defense-in-depth.
  //
  // Safety: `git.mainBranch` / `git.devBranch` are validated by `isSafeBranchName` at
  // capture in `runGitVerificationQa`, so the single-quoted YAML expression and the
  // double-quoted shell line below cannot be broken by injected metacharacters.
  if (shouldRenderPrSourceGuardrail(spec)) {
    const git = spec.ci.git!;
    lines.push(
      "  verify-pr-source:",
      `    if: github.event.pull_request.base.ref == '${git.mainBranch}'`,
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Reject PRs into main from non-dev branches",
      "        shell: bash",
      "        run: |",
      `          if [ "${PR_HEAD_REF_EXPR}" != "${git.devBranch}" ]; then`,
      `            echo "PRs into '${git.mainBranch}' must come from '${git.devBranch}'." >&2`,
      "            exit 1",
      "          fi",
    );
  }

  lines.push("");
  return lines.join("\n");
}

function shouldRenderPrSourceGuardrail(spec: HarnessDesignSpec): boolean {
  const git = spec.ci.git;
  if (!git) return false;
  if (!git.enforceMainFromDevOnly) return false;
  if (!git.devBranch) return false;
  if (git.devBranch === git.mainBranch) return false;
  return true;
}

async function applyAntiSlopBackend(
  input: ApplyHarnessPlanInput,
  outcome: ApplyOutcome,
  apply: boolean,
): Promise<void> {
  const backend = input.spec.antiSlop.backend;
  const entryPoints = collectEntryPoints(input.cwd);

  if (backend === "fallow" || backend === "hybrid") {
    const step = "Install fallow + write .fallowrc.json";
    const result = await installFallow(input.paths, {
      cwd: input.cwd,
      backend,
      layerRules: input.spec.layerRules,
      entryPoints,
      skillTargets: input.spec.antiSlop.skillTargets,
      apply,
    });
    foldInstallResult(step, result, outcome);
  }

  if (backend === "desloppify" || backend === "hybrid") {
    const gitignoreStep = "Install desloppify (gitignore)";
    const gitignoreResult = await ensureDesloppifyGitignore({ cwd: input.cwd, apply });
    foldInstallResult(gitignoreStep, gitignoreResult, outcome);

    if (input.spec.antiSlop.skillTargets.length > 0) {
      const skillStep = "Distribute agent-skills";
      const skillResult = await distributeAgentSkills(input.platform, {
        cwd: input.cwd,
        targets: input.spec.antiSlop.skillTargets,
        apply,
      });
      foldInstallResult(skillStep, skillResult, outcome);
    }
  }

  if (backend === "supi-native") {
    outcome.applied.push({
      step: "Install anti-slop backend",
      path: "(none)",
      action: "noop",
      detail: "supi-native backend has no external installer",
    });
  }
}

function foldInstallResult(
  step: string,
  result: { ok: boolean; actions: string[]; warnings: string[] },
  outcome: ApplyOutcome,
): void {
  for (const action of result.actions) {
    outcome.applied.push({
      step,
      path: "(installer)",
      action: action.startsWith("wrote") || action.startsWith("appended")
        ? "wrote"
        : action.includes("already")
          ? "skipped"
          : "noop",
      detail: action,
    });
  }
  for (const warning of result.warnings) {
    outcome.warnings.push(`${step}: ${warning}`);
  }
  if (!result.ok) {
    outcome.errors.push({
      step,
      message: `installer reported failure: ${result.warnings.join("; ") || "see warnings"}`,
    });
  }
}

/**
 * Walk the repo's top-level package manifest to pick reasonable entry points. The fallow
 * installer accepts any non-empty array; we err on the side of "every top-level src dir"
 * so the audit covers user code without needing manual edits.
 */
function collectEntryPoints(cwd: string): readonly string[] {
  const candidates = ["src", "lib", "app", "packages"];
  const found = candidates.filter((dir) => {
    try {
      return fs.statSync(path.join(cwd, dir)).isDirectory();
    } catch {
      return false;
    }
  });
  return found.length > 0 ? found : ["."];
}

function applyHarnessMarker(
  input: ApplyHarnessPlanInput,
  outcome: ApplyOutcome,
  apply: boolean,
): void {
  const step = "Enable repo-local anti-slop hooks";
  const reportPath = ".omp/supipowers/harness/marker.json";
  const desired = {
    installedAt: new Date(0).toISOString(), // overridden below; only used for diff identity
    backend: input.spec.antiSlop.backend,
    notes: [
      `Generated by /supi:harness session ${input.spec.sessionId}.`,
      `Run /supi:harness status to inspect; /supi:harness validate to verify.`,
    ],
  } satisfies { installedAt: string; backend: HarnessAntiSlopBackend; notes: string[] };

  // Idempotency: if a marker already exists with the same backend + notes, skip the
  // write entirely so commit history stays clean across rebuilds.
  const markerPath = path.join(getHarnessRepoLocalDir(input.paths, input.cwd), "marker.json");
  let existingBackend: string | null = null;
  if (fs.existsSync(markerPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(markerPath, "utf8")) as { backend?: string };
      existingBackend = parsed.backend ?? null;
    } catch {
      existingBackend = null;
    }
  }
  if (existingBackend === desired.backend) {
    outcome.applied.push({
      step,
      path: reportPath,
      action: "skipped",
      detail: `marker.json already records backend=${desired.backend}`,
    });
    return;
  }
  if (!apply) {
    outcome.applied.push({
      step,
      path: reportPath,
      action: "noop",
      detail: existingBackend === null ? "would create marker.json" : "would update marker.json",
    });
    return;
  }

  const result = writeMarker(input.paths, input.cwd, {
    installedAt: new Date().toISOString(),
    backend: desired.backend,
    notes: desired.notes,
  });
  if (!result.ok) {
    outcome.errors.push({ step, message: result.message });
    return;
  }
  outcome.applied.push({
    step,
    path: reportPath,
    action: existingBackend === null ? "wrote" : "patched",
    detail: `backend=${desired.backend}`,
  });
}

function applySlopQueueInit(
  input: ApplyHarnessPlanInput,
  outcome: ApplyOutcome,
  apply: boolean,
): void {
  const step = "Initialize slop queue";
  const queuePath = getHarnessQueuePath(input.paths, input.cwd);
  if (fs.existsSync(queuePath)) {
    outcome.applied.push({
      step,
      path: "queue.jsonl",
      action: "skipped",
      detail: "queue already exists",
    });
    return;
  }
  if (!apply) {
    outcome.applied.push({
      step,
      path: "queue.jsonl",
      action: "noop",
      detail: "would create empty queue.jsonl",
    });
    return;
  }
  try {
    fs.mkdirSync(path.dirname(queuePath), { recursive: true });
    fs.writeFileSync(queuePath, "");
    outcome.applied.push({
      step,
      path: "queue.jsonl",
      action: "wrote",
      detail: "created empty queue",
    });
  } catch (error) {
    outcome.errors.push({ step, message: `failed to create queue.jsonl: ${describe(error)}` });
  }
}

function applyScorecardSkeleton(
  input: ApplyHarnessPlanInput,
  outcome: ApplyOutcome,
  apply: boolean,
): void {
  const step = "Generate scorecard skeleton + README badge";
  const queueResult = readSlopQueue(input.paths, input.cwd);
  const entries: HarnessSlopQueueEntry[] = queueResult.ok ? queueResult.value : [];
  const score = computeScore({
    computedAt: new Date().toISOString(),
    entries,
  });
  const reportPath = ".omp/supipowers/harness/score.json";

  // Idempotency uses the score *shape* (everything but computedAt), so re-runs against
  // an unchanged queue produce no diff.
  const existing = readExistingScore(input);
  if (existing && scoresEquivalent(existing, score)) {
    outcome.applied.push({
      step,
      path: reportPath,
      action: "skipped",
      detail: `score lenient=${score.lenient} strict=${score.strict} unchanged`,
    });
    return;
  }
  if (!apply) {
    outcome.applied.push({
      step,
      path: reportPath,
      action: "noop",
      detail: existing === null ? "would create score.json" : "would refresh score.json",
    });
    return;
  }
  const saved = saveHarnessRepoScore(input.paths, input.cwd, score);
  if (!saved.ok) {
    outcome.errors.push({ step, message: saved.error.message });
    return;
  }
  outcome.applied.push({
    step,
    path: reportPath,
    action: existing === null ? "wrote" : "patched",
    detail: `lenient=${score.lenient} strict=${score.strict}`,
  });
}

interface ScoreShape {
  lenient: number;
  strict: number;
  dimensions: unknown[];
}

function readExistingScore(input: ApplyHarnessPlanInput): ScoreShape | null {
  const scorePath = path.join(
    getHarnessRepoLocalDir(input.paths, input.cwd),
    "score.json",
  );
  if (!fs.existsSync(scorePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(scorePath, "utf8")) as Partial<ScoreShape>;
    if (typeof parsed.lenient !== "number" || typeof parsed.strict !== "number") return null;
    return {
      lenient: parsed.lenient,
      strict: parsed.strict,
      dimensions: Array.isArray(parsed.dimensions) ? parsed.dimensions : [],
    };
  } catch {
    return null;
  }
}

function scoresEquivalent(a: ScoreShape, b: { lenient: number; strict: number; dimensions: unknown[] }): boolean {
  if (a.lenient !== b.lenient || a.strict !== b.strict) return false;
  return JSON.stringify(a.dimensions) === JSON.stringify(b.dimensions);
}

function applyReviewAgent(
  input: ApplyHarnessPlanInput,
  outcome: ApplyOutcome,
  apply: boolean,
): void {
  if (!input.spec.supipowersWiring.addReviewAgent) return;
  const absPath = getLocalStatePath(
    input.paths,
    input.cwd,
    "review-agents",
    "harness-architecture.md",
  );
  writeIfChanged(
    {
      step: "Add architecture-aware review agent",
      absPath,
      reportPath: ".omp/supipowers/review-agents/harness-architecture.md",
      contents: renderHarnessArchitectureReviewAgent({ spec: input.spec }),
    },
    apply,
    outcome,
  );
}

/**
 * The supipowers config schema does not yet model `harness.*` fields, so we cannot edit
 * `.omp/supipowers/config.json` without breaking validation. Persist the wiring intent
 * to a sidecar `checks-wiring.json` next to the marker; a future config-schema extension
 * can promote it into the canonical config file.
 */
function applyChecksGateWiring(
  input: ApplyHarnessPlanInput,
  outcome: ApplyOutcome,
  apply: boolean,
): void {
  if (!input.spec.supipowersWiring.wireChecksGate) return;
  const step = "Wire `/supi:checks` gate";
  const reportPath = ".omp/supipowers/harness/checks-wiring.json";
  const absPath = path.join(getHarnessRepoLocalDir(input.paths, input.cwd), "checks-wiring.json");
  const patch = buildChecksWiringPatch({
    backend: input.spec.antiSlop.backend,
    strictFloor: input.spec.antiSlop.hooks.score_floor.strict,
    releaseBlocking: input.spec.antiSlop.hooks.score_floor.release_blocking,
  });
  const contents = `${JSON.stringify(patch, null, 2)}\n`;
  writeIfChanged({ step, absPath, reportPath, contents }, apply, outcome);
}

function applyAgentsMd(
  input: ApplyHarnessPlanInput,
  outcome: ApplyOutcome,
  apply: boolean,
): void {
  const absPath = getHarnessAgentsMdPath(input.paths, input.cwd);
  const backendLabel = backendDisplayLabel(input.spec.antiSlop.backend);
  const contents = renderAgentsMd({
    projectName: path.basename(input.cwd) || "project",
    spec: input.spec,
    backendLabel,
    bootstrapHint: detectBootstrapHint(input.cwd),
  });
  writeIfChanged(
    {
      step: "Generate AGENTS.md",
      absPath,
      reportPath: "AGENTS.md",
      contents,
    },
    apply,
    outcome,
  );
}

function backendDisplayLabel(backend: HarnessAntiSlopBackend): string {
  switch (backend) {
    case "fallow":
      return "fallow";
    case "desloppify":
      return "desloppify";
    case "hybrid":
      return "fallow + desloppify (hybrid)";
    case "supi-native":
      return "supi-native";
  }
}

function detectBootstrapHint(cwd: string): string | undefined {
  if (fs.existsSync(path.join(cwd, "bun.lockb")) || fs.existsSync(path.join(cwd, "bun.lock"))) {
    return "bun install && bun test";
  }
  if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) {
    return "pnpm install && pnpm test";
  }
  if (fs.existsSync(path.join(cwd, "yarn.lock"))) {
    return "yarn && yarn test";
  }
  if (fs.existsSync(path.join(cwd, "package-lock.json"))) {
    return "npm install && npm test";
  }
  return undefined;
}
