import path from "node:path";
import { matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type Focusable } from "@oh-my-pi/pi-tui";
import type { Platform } from "../platform/types.js";
import { createWorkflowProgress } from "../platform/progress.js";
import { notifyInfo } from "../notifications/renderer.js";
import { modelRegistry } from "../config/model-registry-instance.js";
import { createModelBridge, resolveModelForAction } from "../config/model-resolver.js";
import { loadModelConfig } from "../config/model-config.js";
import { selectReviewScope, type ReviewWorkspaceSelection } from "../review/scope.js";
import { loadMergedReviewAgents } from "../review/agent-loader.js";
import { runQuickReview, runDeepReview } from "../review/runner.js";
import { runMultiAgentReview, type MultiAgentAgentResult } from "../review/multi-agent-runner.js";
import { validateReviewFindings } from "../review/validator.js";
import { consolidateReviewOutputs } from "../review/consolidator.js";
import { compareReviewOutputs, runAutoFix } from "../review/fixer.js";
import {
  createReviewSession,
  generateReviewSessionId,
  updateReviewSession,
  writeReviewArtifact,
} from "../storage/review-sessions.js";
import { accent, bright, muted } from "../platform/tui-colors.js";
import { resolvePackageManager } from "../workspace/package-manager.js";
import { resolveRepoRoot } from "../workspace/repo-root.js";
import {
  buildWorkspaceTargetOptionLabel,
  parseTargetArg,
  selectWorkspaceTarget,
  type WorkspaceTargetOption,
} from "../workspace/selector.js";
import { getTargetStatePath } from "../workspace/state-paths.js";
import { discoverWorkspaceTargets } from "../workspace/targets.js";
import type {
  ConfiguredReviewAgent,
  ReviewFinding,
  ReviewLevel,
  ReviewOutput,
  ReviewPostConsolidationAction,
  ReviewScope,
  ReviewSession,
  WorkspaceTarget,
} from "../types.js";

modelRegistry.register({
  id: "ai-review",
  category: "command",
  label: "AI Review",
  harnessRoleHint: "slow",
});

const ITERATIONS_DIR = "iterations";
const AGENTS_DIR = "agents";
const RAW_FINDINGS_FILE = "findings-raw.json";
const VALIDATED_FINDINGS_FILE = "findings-validated.json";
const CONSOLIDATED_FINDINGS_FILE = "findings-consolidated.json";
const FINDINGS_REPORT_FILE = "findings.md";

const REVIEW_RESULTS_ACTIONS: Array<{
  value: ReviewPostConsolidationAction;
  label: string;
  description: string;
}> = [
  {
    value: "fix-now",
    label: "Fix now",
    description: "Apply safe automatic fixes now, then offer a review loop that re-runs the review and refreshes findings.md.",
  },
  {
    value: "document-only",
    label: "Document only",
    description: "Keep the validated findings as findings.md, save the session, and finish without changing code.",
  },
  {
    value: "discuss-before-fixing",
    label: "Discuss before fixing",
    description: "Save findings.md and the session first, then hand off to the active conversation to plan the fixes.",
  },
];

const REVIEW_PRIORITY_ORDER = ["P0", "P1", "P2", "P3"] as const;
const REVIEW_SEVERITY_ORDER = ["error", "warning", "info"] as const;

interface ReviewResultsSummary {
  statusLine: string;
  summaryLine: string;
  severityLine: string;
  priorityLine: string;
  processingLine: string;
  reportPathLine: string;
  topFindings: string[];
  lines: string[];
  helpText: string;
}

interface ParsedAiReviewArgs {
  requestedTarget: string | null;
}

interface ReviewTargetChoice extends ReviewWorkspaceSelection {}

function parseAiReviewArgs(args?: string): ParsedAiReviewArgs {
  return {
    requestedTarget: parseTargetArg(args),
  };
}

function buildReviewTargetSummary(target: WorkspaceTarget): string {
  return `${target.name} (${target.relativeDir})`;
}

async function selectReviewTarget(
  platform: Platform,
  ctx: any,
  requestedTarget: string | null,
): Promise<ReviewTargetChoice | null> {
  const repoRoot = await resolveRepoRoot(platform, ctx.cwd);
  const packageManager = resolvePackageManager(repoRoot);
  const discoveredTargets = discoverWorkspaceTargets(repoRoot, packageManager.id);
  const targets = discoveredTargets.length > 0
    ? discoveredTargets
    : [{
        id: "root",
        name: path.basename(repoRoot) || "root",
        kind: "root",
        repoRoot,
        packageDir: repoRoot,
        manifestPath: path.join(repoRoot, "package.json"),
        relativeDir: ".",
        version: "0.0.0",
        private: true,
        packageManager: packageManager.id,
      } satisfies WorkspaceTarget];
  const selectedTarget = await selectWorkspaceTarget(
    ctx,
    targets.map((target) => ({
      target,
      changed: false,
      label: buildWorkspaceTargetOptionLabel({ target, changed: false } satisfies WorkspaceTargetOption),
    })),
    requestedTarget,
    {
      title: "Review target",
      helpText: "Pick one package or the root scope for this review run.",
    },
  );

  if (requestedTarget && !selectedTarget) {
    throw new Error(`Review target not found: ${requestedTarget}`);
  }

  return selectedTarget ? { target: selectedTarget, targets } : null;
}


function formatFindingLocation(finding: ReviewFinding): string {
  if (!finding.file) {
    return "unknown location";
  }

  if (!finding.lineStart) {
    return finding.file;
  }

  return finding.lineEnd && finding.lineEnd !== finding.lineStart
    ? `${finding.file}:${finding.lineStart}-${finding.lineEnd}`
    : `${finding.file}:${finding.lineStart}`;
}

function sortFindingsForDisplay(findings: ReviewFinding[]): ReviewFinding[] {
  return [...findings].sort((left, right) => {
    const priorityDelta = REVIEW_PRIORITY_ORDER.indexOf(left.priority) - REVIEW_PRIORITY_ORDER.indexOf(right.priority);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }

    const severityDelta = REVIEW_SEVERITY_ORDER.indexOf(left.severity) - REVIEW_SEVERITY_ORDER.indexOf(right.severity);
    if (severityDelta !== 0) {
      return severityDelta;
    }

    const fileDelta = (left.file ?? "").localeCompare(right.file ?? "");
    if (fileDelta !== 0) {
      return fileDelta;
    }

    return (left.lineStart ?? Number.MAX_SAFE_INTEGER) - (right.lineStart ?? Number.MAX_SAFE_INTEGER);
  });
}

function formatConfidence(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

function buildCountLine<T extends string>(label: string, values: readonly T[], counts: Map<T, number>): string {
  return `${label}: ${values.map((value) => `${value} ${counts.get(value) ?? 0}`).join(", ")}`;
}

function preserveBlockedReviewStatus(
  output: ReviewOutput,
  upstreamStatus: ReviewOutput["status"],
): ReviewOutput {
  if (upstreamStatus !== "blocked" || output.status === "blocked") {
    return output;
  }

  const summary = output.summary.includes("Some specialist agents were blocked during review.")
    ? output.summary
    : `${output.summary} Some specialist agents were blocked during review.`;

  return {
    ...output,
    status: "blocked",
    summary,
  };
}

function prepareReviewOutputForFollowUp(
  output: ReviewOutput,
  upstreamStatus: ReviewOutput["status"],
): ReviewOutput {
  const normalizedOutput = preserveBlockedReviewStatus(output, upstreamStatus);
  const findings = normalizedOutput.findings.filter((finding) => finding.validation?.verdict !== "rejected");
  if (findings.length === normalizedOutput.findings.length) {
    return normalizedOutput;
  }

  const removedCount = normalizedOutput.findings.length - findings.length;
  const summary = `${normalizedOutput.summary} Removed ${removedCount} rejected finding${removedCount === 1 ? "" : "s"} from follow-up.`;

  return {
    ...normalizedOutput,
    findings,
    summary,
  };
}


function buildReviewFindingsMarkdown(
  output: ReviewOutput,
  session: ReviewSession,
  options: { preFixSnapshot?: boolean } = {},
): string {
  const sortedFindings = sortFindingsForDisplay(output.findings);

  const sections = [
    "# supi:review findings",
    "",
    `- Session: \`${session.id}\``,
    `- Scope: ${session.scope.description}`,
    `- Status: ${output.status}`,
    `- Findings: ${output.findings.length}`,
    `- Validation: ${session.validateFindings ? "done" : "skipped"}`,
    `- Consolidation: ${session.consolidate ? "done" : "skipped"}`,
    ...(options.preFixSnapshot
      ? [
          `- Snapshot: pre-fix review output`,
          "",
          "## Snapshot",
          "",
          "This report captures the last review pass before automatic fixes changed the working tree.",
          "Run the review loop to verify the current findings after those fixes.",
        ]
      : []),
    "",
    "## Summary",
    "",
    output.summary,
    "",
    "## Findings",
    "",
  ];

  if (sortedFindings.length === 0) {
    sections.push("No findings.");
    return `${sections.join("\n")}\n`;
  }

  sortedFindings.forEach((finding, index) => {
    sections.push(`### ${index + 1}. [${finding.priority}/${finding.severity}] ${finding.title}`);
    sections.push("");
    sections.push(`- Location: \`${formatFindingLocation(finding)}\``);
    sections.push(`- Confidence: ${formatConfidence(finding.confidence)}`);
    if (finding.agent) {
      sections.push(`- Agent: ${finding.agent}`);
    }
    if (finding.validation) {
      sections.push(`- Validation: ${finding.validation.verdict} — ${finding.validation.reasoning}`);
    }
    sections.push("");
    sections.push(finding.body);
    if (finding.suggestion) {
      sections.push("");
      sections.push(`Suggested fix: ${finding.suggestion}`);
    }
    sections.push("");
  });

  return `${sections.join("\n")}\n`;
}

function buildReviewResultsSummary(
  output: ReviewOutput,
  session: Pick<ReviewSession, "validateFindings" | "consolidate">,
  findingsReportPath: string,
  maxFindings = 3,
): ReviewResultsSummary {
  const severityCounts = new Map<(typeof REVIEW_SEVERITY_ORDER)[number], number>(
    REVIEW_SEVERITY_ORDER.map((value) => [value, 0]),
  );
  const priorityCounts = new Map<(typeof REVIEW_PRIORITY_ORDER)[number], number>(
    REVIEW_PRIORITY_ORDER.map((value) => [value, 0]),
  );

  for (const finding of output.findings) {
    severityCounts.set(finding.severity, (severityCounts.get(finding.severity) ?? 0) + 1);
    priorityCounts.set(finding.priority, (priorityCounts.get(finding.priority) ?? 0) + 1);
  }

  const topFindings = sortFindingsForDisplay(output.findings)
    .slice(0, maxFindings)
    .map((finding) => `[${finding.priority}/${finding.severity}] ${finding.title} — ${formatFindingLocation(finding)}`);

  const statusLine = `Status: ${output.status} • Findings: ${output.findings.length}`;
  const summaryLine = `Summary: ${output.summary}`;
  const severityLine = buildCountLine("Severity", REVIEW_SEVERITY_ORDER, severityCounts);
  const priorityLine = buildCountLine("Priority", REVIEW_PRIORITY_ORDER, priorityCounts);
  const processingLine = [
    `Validation: ${session.validateFindings ? "done" : "skipped"}`,
    `Consolidation: ${session.consolidate ? "done" : "skipped"}`,
  ].join(" • ");
  const reportPathLine = `Findings document: ${findingsReportPath}`;

  const lines = [statusLine, summaryLine, severityLine, priorityLine, processingLine, reportPathLine];
  if (topFindings.length > 0) {
    lines.push("Top findings:", ...topFindings.map((finding, index) => `${index + 1}. ${finding}`));
  }

  return {
    statusLine,
    summaryLine,
    severityLine,
    priorityLine,
    processingLine,
    reportPathLine,
    topFindings,
    lines,
    helpText: lines.join("\n"),
  };
}

function resolveReviewResultsAction(choice: string | null): ReviewPostConsolidationAction | null {
  if (!choice) {
    return null;
  }

  return REVIEW_RESULTS_ACTIONS.find((action) => action.label === choice || action.value === choice)?.value ?? null;
}

function wrapScreenLines(lines: string[], width: number): string[] {
  const safeWidth = Math.max(1, width);
  return lines.flatMap((line) => {
    if (line === "") {
      return [""];
    }

    const wrapped = wrapTextWithAnsi(line, safeWidth);
    return wrapped.length > 0 ? wrapped : [truncateToWidth(line, safeWidth)];
  });
}


function createReviewResultsApprovalScreen(
  tui: any,
  done: (result: ReviewPostConsolidationAction | null) => void,
  summary: ReviewResultsSummary,
): Component & Focusable & { dispose(): void } {
  let selectedIndex = 0;

  return {
    focused: true,

    dispose(): void {
      // No cleanup required for this ephemeral screen.
    },

    invalidate(): void {
      // No cached state to reset.
    },

    handleInput(data: string): void {
      if (matchesKey(data, "escape")) {
        done(null);
        return;
      }

      if (matchesKey(data, "enter")) {
        done(REVIEW_RESULTS_ACTIONS[selectedIndex]?.value ?? null);
        return;
      }

      if (matchesKey(data, "up")) {
        selectedIndex = selectedIndex === 0 ? REVIEW_RESULTS_ACTIONS.length - 1 : selectedIndex - 1;
        tui.requestRender();
        return;
      }

      if (matchesKey(data, "down")) {
        selectedIndex = selectedIndex === REVIEW_RESULTS_ACTIONS.length - 1 ? 0 : selectedIndex + 1;
        tui.requestRender();
      }
    },

    render(width: number): string[] {
      const lines = [
        bright("Review results"),
        "",
        ...summary.lines,
        "",
        bright("Choose next step"),
        ...REVIEW_RESULTS_ACTIONS.map((action, index) =>
          index === selectedIndex
            ? accent(`> ${action.label} — ${action.description}`)
            : `  ${action.label} — ${action.description}`
        ),
        "",
        muted("↑/↓ select • Enter confirm • Esc cancel"),
      ];

      return wrapScreenLines(lines, width);
    },
  };
}

async function selectReviewResultsAction(
  ctx: any,
  summary: ReviewResultsSummary,
): Promise<ReviewPostConsolidationAction | null> {
  if (typeof ctx.ui.custom === "function") {
    const choice = await ctx.ui.custom((_tui: any, _theme: any, _kb: any, done: any) =>
      createReviewResultsApprovalScreen(_tui, done, summary),
    );
    return resolveReviewResultsAction(choice ?? null);
  }

  const choice = await ctx.ui.select(
    "Review results",
    REVIEW_RESULTS_ACTIONS.map((action) => action.label),
    { helpText: summary.helpText },
  );

  return resolveReviewResultsAction(choice ?? null);
}

function buildDiscussionPrompt(
  platform: Platform,
  ctx: any,
  session: ReviewSession,
  summary: ReviewResultsSummary,
  selectedTarget: WorkspaceTarget | null,
): string {
  const sessionDir = buildSavedSessionPath(platform, ctx, session, selectedTarget);
  const artifactLines = [
    `- session: ${sessionDir}/session.json`,
    `- scope: ${sessionDir}/${session.artifacts.scope}`,
    `- iterations: ${sessionDir}/${session.artifacts.iterationsDir}/`,
    ...(session.artifacts.rawFindings ? [`- raw findings: ${sessionDir}/${session.artifacts.rawFindings}`] : []),
    ...(session.artifacts.validatedFindings
      ? [`- validated findings: ${sessionDir}/${session.artifacts.validatedFindings}`]
      : []),
    ...(session.artifacts.consolidatedFindings
      ? [`- consolidated findings: ${sessionDir}/${session.artifacts.consolidatedFindings}`]
      : []),
    ...(session.artifacts.findingsReport
      ? [`- findings document: ${sessionDir}/${session.artifacts.findingsReport}`]
      : []),
  ];

  const topFindings = summary.topFindings.length > 0
    ? summary.topFindings.map((finding, index) => `${index + 1}. ${finding}`).join("\n")
    : "None.";

  return [
    `Review session ${session.id} is saved and ready for discussion.`,
    "",
    `Scope: ${session.scope.description}`,
    summary.statusLine,
    summary.summaryLine,
    summary.reportPathLine,
    "",
    "Top findings:",
    topFindings,
    "",
    "Saved artifacts:",
    ...artifactLines,
    "",
    "Discuss the findings and plan the fixes before changing code. Do not auto-apply fixes yet.",
  ].join("\n");
}

function buildPostConsolidationDetail(action: ReviewPostConsolidationAction): string {
  switch (action) {
    case "fix-now":
      return "fix now";
    case "document-only":
      return "document only";
    case "discuss-before-fixing":
      return "discuss";
  }
}

function buildSavedSessionPath(
  platform: Platform,
  ctx: any,
  session: ReviewSession,
  selectedTarget: WorkspaceTarget | null,
): string {
  return selectedTarget
    ? getTargetStatePath(platform.paths, selectedTarget, "reviews", session.id)
    : platform.paths.project(ctx.cwd, "reviews", session.id);
}

function buildActionLabel(action: ReviewPostConsolidationAction | null): string {
  switch (action) {
    case "fix-now":
      return "fix now";
    case "document-only":
      return "document only";
    case "discuss-before-fixing":
      return "discuss before fixing";
    default:
      return "none";
  }
}


interface ReviewIterationResult {
  output: ReviewOutput;
  rawOutput: ReviewOutput;
  agentResults: MultiAgentAgentResult[];
  validatedOutput?: ReviewOutput;
  consolidatedOutput?: ReviewOutput;
}

export interface AiReviewCommandDependencies {
  loadModelConfig: typeof loadModelConfig;
  createModelBridge: typeof createModelBridge;
  resolveModelForAction: typeof resolveModelForAction;
  selectReviewScope: typeof selectReviewScope;
  loadReviewAgents: typeof loadMergedReviewAgents;
  runQuickReview: typeof runQuickReview;
  runDeepReview: typeof runDeepReview;
  runMultiAgentReview: typeof runMultiAgentReview;
  validateReviewFindings: typeof validateReviewFindings;
  consolidateReviewOutputs: typeof consolidateReviewOutputs;
  runAutoFix: typeof runAutoFix;
  createReviewSession: typeof createReviewSession;
  updateReviewSession: typeof updateReviewSession;
  writeReviewArtifact: typeof writeReviewArtifact;
  generateReviewSessionId: typeof generateReviewSessionId;
  notifyInfo: typeof notifyInfo;
}

const AI_REVIEW_COMMAND_DEPENDENCIES: AiReviewCommandDependencies = {
  loadModelConfig,
  createModelBridge,
  resolveModelForAction,
  selectReviewScope,
  loadReviewAgents: loadMergedReviewAgents,
  runQuickReview,
  runDeepReview,
  runMultiAgentReview,
  validateReviewFindings,
  consolidateReviewOutputs,
  runAutoFix,
  createReviewSession,
  updateReviewSession,
  writeReviewArtifact,
  generateReviewSessionId,
  notifyInfo,
};

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function createAiReviewSteps(level: ReviewLevel, agents: ConfiguredReviewAgent[]) {
  return [
    { key: "scope", label: "Scope discovery" },
    ...(level === "multi-agent"
      ? agents.map((agent) => ({ key: `agent-${agent.name}`, label: `${capitalize(agent.name)} agent` }))
      : [{ key: "review", label: `${capitalize(level)} review` }]),
    { key: "validate", label: "Validate findings" },
    { key: "consolidate", label: "Consolidate" },
    { key: "review-results", label: "Review results" },
    { key: "fix", label: "Fix findings" },
    { key: "rerun", label: "Review loop" },
    { key: "save", label: "Save session" },
  ];
}

function truncateDetail(detail: string, maxLength = 64): string {
  const normalized = detail.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function createAiReviewProgress(ctx: any, level: ReviewLevel, agents: ConfiguredReviewAgent[]) {
  const progress = createWorkflowProgress(ctx.ui, {
    title: "supi:review",
    statusKey: "supi-ai-review",
    widgetKey: "supi-ai-review",
    steps: createAiReviewSteps(level, agents),
  });
  let activeStep: string | null = null;

  function activate(stepKey: string, detail?: string) {
    activeStep = stepKey;
    progress.activate(stepKey, detail ? truncateDetail(detail) : undefined);
  }

  function complete(stepKey: string, detail?: string) {
    if (activeStep === stepKey) {
      activeStep = null;
    }
    progress.complete(stepKey, detail ? truncateDetail(detail) : undefined);
  }

  function skip(stepKey: string, detail: string) {
    if (activeStep === stepKey) {
      activeStep = null;
    }
    progress.skip(stepKey, truncateDetail(detail));
  }

  function fail(stepKey: string, detail: string) {
    if (activeStep === stepKey) {
      activeStep = null;
    }
    progress.fail(stepKey, truncateDetail(detail));
  }

  return {
    completeScope(scope: ReviewScope) {
      complete("scope", `${scope.stats.filesChanged} changed file(s)`);
    },
    startSingle(levelName: ReviewLevel) {
      activate("review", `${levelName} review`);
    },
    completeSingle(output: ReviewOutput) {
      complete("review", `${output.findings.length} finding(s)`);
    },
    startAgent(agent: ConfiguredReviewAgent) {
      activate(`agent-${agent.name}`, "running");
    },
    completeAgent(result: MultiAgentAgentResult) {
      complete(`agent-${result.agent.name}`, `${result.output.findings.length} finding(s)`);
    },
    skipValidate(reason: string) {
      skip("validate", reason);
    },
    startValidate() {
      activate("validate", "cross-checking code");
    },
    completeValidate(output: ReviewOutput) {
      complete("validate", `${output.findings.length} finding(s)`);
    },
    skipConsolidate(reason: string) {
      skip("consolidate", reason);
    },
    startConsolidate() {
      activate("consolidate", "merging findings");
    },
    completeConsolidate(output: ReviewOutput) {
      complete("consolidate", `${output.findings.length} unique finding(s)`);
    },
    skipReviewResults(reason: string) {
      skip("review-results", reason);
    },
    startReviewResults() {
      activate("review-results", "awaiting approval");
    },
    completeReviewResults(detail: string) {
      complete("review-results", detail);
    },
    skipFix(reason: string) {
      skip("fix", reason);
    },
    startFix() {
      activate("fix", "applying fixes");
    },
    completeFix(summary: string) {
      complete("fix", summary);
    },
    skipRerun(reason: string) {
      skip("rerun", reason);
    },
    startRerun(iteration: number, maxIterations: number) {
      activate("rerun", `iteration ${iteration}/${maxIterations}`);
    },
    completeRerun(iteration: number, maxIterations: number) {
      complete("rerun", `iteration ${iteration}/${maxIterations}`);
    },
    startSave() {
      activate("save", "writing session");
    },
    completeSave(status: ReviewSession["status"]) {
      complete("save", status);
    },
    failActive(detail: string) {
      fail(activeStep ?? "save", detail);
    },
    dispose() {
      progress.dispose();
    },
  };
}

function createInitialReviewSession(
  sessionId: string,
  level: ReviewLevel,
  scope: ReviewScope,
  agents: ConfiguredReviewAgent[],
): ReviewSession {
  const now = new Date().toISOString();
  return {
    id: sessionId,
    createdAt: now,
    updatedAt: now,
    level,
    status: "running",
    scope,
    validateFindings: false,
    consolidate: false,
    postConsolidationAction: null,
    maxIterations: 1,
    currentIteration: 0,
    iterations: [],
    fixes: [],
    artifacts: {
      scope: "scope.json",
      iterationsDir: ITERATIONS_DIR,
      agentsDir: AGENTS_DIR,
    },
    agents: agents.map((agent) => agent.name),
  };
}

async function selectReviewLevel(ctx: any): Promise<ReviewLevel | null> {
  const choice = await ctx.ui.select(
    "Review level",
    [
      "Quick — fast high-signal review",
      "Deep — thorough single-agent review",
      "Multi-agent — focused specialist agents",
    ],
    { helpText: "Choose the review depth · Esc to cancel" },
  );

  if (!choice) {
    return null;
  }
  if (choice.startsWith("Quick")) {
    return "quick";
  }
  if (choice.startsWith("Deep")) {
    return "deep";
  }
  return "multi-agent";
}

async function selectYesNo(ctx: any, title: string, helpText: string): Promise<boolean | null> {
  const choice = await ctx.ui.select(title, ["No", "Yes"], { helpText });
  if (!choice) {
    return null;
  }
  return choice === "Yes";
}

async function selectMaxIterations(ctx: any, defaultValue = 3): Promise<number | null> {
  const raw = await ctx.ui.input("Max iterations", {
    helpText: `Maximum review/fix cycles (default ${defaultValue}).`,
    placeholder: String(defaultValue),
  });
  if (raw === null || raw === undefined || raw === "") {
    return defaultValue;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error("Max iterations must be a positive integer.");
  }
  return parsed;
}

function buildCompletionDetail(
  session: ReviewSession,
  output: ReviewOutput,
  selectedTarget: WorkspaceTarget | null,
 ): string {
  return [
    `session: ${session.id}`,
    ...(selectedTarget ? [`target: ${buildReviewTargetSummary(selectedTarget)}`] : []),
    `status: ${output.status}`,
    `findings: ${output.findings.length}`,
    `iterations: ${session.currentIteration}`,
    `action: ${buildActionLabel(session.postConsolidationAction)}`,
  ].join(" | ");
}

function writeFindingsReport(
  deps: AiReviewCommandDependencies,
  platform: Platform,
  ctx: any,
  session: ReviewSession,
  output: ReviewOutput,
  selectedTarget: WorkspaceTarget | null,
  options: { preFixSnapshot?: boolean } = {},
): string {
  const artifactPath = deps.writeReviewArtifact(
    platform.paths,
    ctx.cwd,
    session.id,
    FINDINGS_REPORT_FILE,
    buildReviewFindingsMarkdown(output, session, options),
    selectedTarget,
  );
  session.artifacts.findingsReport = FINDINGS_REPORT_FILE;
  return artifactPath;
}

function persistIteration(
  deps: AiReviewCommandDependencies,
  platform: Platform,
  ctx: any,
  session: ReviewSession,
  iteration: number,
  output: ReviewOutput,
  selectedTarget: WorkspaceTarget | null,
  extra: Record<string, unknown> = {},
): void {
  const relativePath = `${ITERATIONS_DIR}/${iteration}.json`;
  deps.writeReviewArtifact(platform.paths, ctx.cwd, session.id, relativePath, {
    output,
    ...extra,
  }, selectedTarget);
  session.iterations.push({
    iteration,
    findings: output.findings.length,
    status: output.status,
    file: relativePath,
    createdAt: new Date().toISOString(),
  });
  session.currentIteration = iteration;
}

async function runReviewPass(
  platform: Platform,
  ctx: any,
  deps: AiReviewCommandDependencies,
  scope: ReviewScope,
  level: ReviewLevel,
  agents: ConfiguredReviewAgent[],
  progress: ReturnType<typeof createAiReviewProgress>,
  resolvedModel: { model: string | undefined; thinkingLevel: string | null },
): Promise<{ rawOutput: ReviewOutput; agentResults: MultiAgentAgentResult[] }> {
  if (level === "quick") {
    progress.startSingle(level);
    const result = await deps.runQuickReview({
      cwd: ctx.cwd,
      scope,
      createAgentSession: platform.createAgentSession.bind(platform),
      model: resolvedModel.model,
      thinkingLevel: resolvedModel.thinkingLevel,
    });
    progress.completeSingle(result.output);
    return {
      rawOutput: result.output,
      agentResults: [],
    };
  }

  if (level === "deep") {
    progress.startSingle(level);
    const result = await deps.runDeepReview({
      cwd: ctx.cwd,
      scope,
      createAgentSession: platform.createAgentSession.bind(platform),
      model: resolvedModel.model,
      thinkingLevel: resolvedModel.thinkingLevel,
    });
    progress.completeSingle(result.output);
    return {
      rawOutput: result.output,
      agentResults: [],
    };
  }

  const result = await deps.runMultiAgentReview({
    cwd: ctx.cwd,
    scope,
    agents,
    createAgentSession: platform.createAgentSession.bind(platform),
    model: resolvedModel.model,
    thinkingLevel: resolvedModel.thinkingLevel,
    onAgentStart: (agent) => progress.startAgent(agent),
    onAgentComplete: (agentResult) => progress.completeAgent(agentResult),
  });
  return {
    rawOutput: result.output,
    agentResults: result.agents,
  };
}

async function runAiReviewSession(
  platform: Platform,
  ctx: any,
  deps: AiReviewCommandDependencies = AI_REVIEW_COMMAND_DEPENDENCIES,
  args?: string,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("/supi:review requires interactive mode.", "warning");
    return;
  }

  const { requestedTarget } = parseAiReviewArgs(args);
  const selectedReviewTarget = await selectReviewTarget(platform, ctx, requestedTarget);
  if (!selectedReviewTarget) {
    return;
  }
  const reviewTarget = selectedReviewTarget;

  const scope = await deps.selectReviewScope(platform, ctx, reviewTarget);
  if (!scope) {
    return;
  }

  const level = await selectReviewLevel(ctx);
  if (!level) {
    return;
  }

  const loadedAgents = level === "multi-agent"
    ? await deps.loadReviewAgents(platform.paths, ctx.cwd, {
        repoRoot: reviewTarget.target.repoRoot,
        workspaceRelativeDir: reviewTarget.target.kind === "workspace" ? reviewTarget.target.relativeDir : null,
      })
    : null;
  const agents = loadedAgents?.agents ?? [];
  if (level === "multi-agent" && agents.length === 0) {
    throw new Error("No enabled review agents are configured.");
  }

  const modelConfig = deps.loadModelConfig(platform.paths, ctx.cwd);
  const modelBridge = deps.createModelBridge(platform);
  const resolvedModel = deps.resolveModelForAction("ai-review", modelRegistry, modelConfig, modelBridge);

  const session = createInitialReviewSession(
    deps.generateReviewSessionId(),
    level,
    scope,
    agents,
  );
  deps.createReviewSession(platform.paths, ctx.cwd, session, reviewTarget.target);
  deps.writeReviewArtifact(platform.paths, ctx.cwd, session.id, session.artifacts.scope, scope, reviewTarget.target);

  const progress = createAiReviewProgress(ctx, level, agents);
  progress.completeScope(scope);

  function saveSession(status: ReviewSession["status"]): void {
    progress.startSave();
    session.status = status;
    deps.updateReviewSession(platform.paths, ctx.cwd, session, reviewTarget.target);
    progress.completeSave(status);
  }

  try {
    const initialRun = await runReviewPass(platform, ctx, deps, scope, level, agents, progress, resolvedModel);
    deps.writeReviewArtifact(
      platform.paths,
      ctx.cwd,
      session.id,
      RAW_FINDINGS_FILE,
      initialRun.rawOutput,
      reviewTarget.target,
    );
    session.artifacts.rawFindings = RAW_FINDINGS_FILE;
    for (const agentResult of initialRun.agentResults) {
      deps.writeReviewArtifact(
        platform.paths,
        ctx.cwd,
        session.id,
        `${AGENTS_DIR}/${agentResult.agent.name}.json`,
        agentResult,
        reviewTarget.target,
      );
    }

    let currentOutput = initialRun.rawOutput;

    if (currentOutput.findings.length > 0) {
      session.validateFindings = true;
      progress.startValidate();
      const validation = await deps.validateReviewFindings({
        cwd: ctx.cwd,
        scope,
        findings: currentOutput.findings,
        createAgentSession: platform.createAgentSession.bind(platform),
        model: resolvedModel.model,
        thinkingLevel: resolvedModel.thinkingLevel,
      });
      const validatedOutput = preserveBlockedReviewStatus(validation.output, currentOutput.status);
      currentOutput = prepareReviewOutputForFollowUp(validatedOutput, currentOutput.status);
      deps.writeReviewArtifact(
        platform.paths,
        ctx.cwd,
        session.id,
        VALIDATED_FINDINGS_FILE,
        validatedOutput,
        reviewTarget.target,
      );
      session.artifacts.validatedFindings = VALIDATED_FINDINGS_FILE;
      progress.completeValidate(validatedOutput);
    } else {
      session.validateFindings = false;
      progress.skipValidate("no findings");
    }

    if (level === "multi-agent" && currentOutput.findings.length > 0) {
      session.consolidate = true;
      progress.startConsolidate();
      currentOutput = prepareReviewOutputForFollowUp(
        deps.consolidateReviewOutputs([currentOutput]),
        currentOutput.status,
      );
      deps.writeReviewArtifact(
        platform.paths,
        ctx.cwd,
        session.id,
        CONSOLIDATED_FINDINGS_FILE,
        currentOutput,
        reviewTarget.target,
      );
      session.artifacts.consolidatedFindings = CONSOLIDATED_FINDINGS_FILE;
      progress.completeConsolidate(currentOutput);
    } else {
      session.consolidate = false;
      progress.skipConsolidate(level === "multi-agent" ? "no findings" : "single-agent");
    }

    persistIteration(deps, platform, ctx, session, 1, currentOutput, reviewTarget.target);
    let findingsReportPath = writeFindingsReport(
      deps,
      platform,
      ctx,
      session,
      currentOutput,
      reviewTarget.target,
    );
    let findingsReportIsPreFixSnapshot = false;

    async function cancelSession(): Promise<void> {
      if (findingsReportIsPreFixSnapshot) {
        findingsReportPath = writeFindingsReport(
          deps,
          platform,
          ctx,
          session,
          currentOutput,
          reviewTarget.target,
          { preFixSnapshot: true },
        );
      }
      saveSession("cancelled");
    }
    const reviewResultsSummary = buildReviewResultsSummary(currentOutput, session, findingsReportPath);

    if (currentOutput.findings.length === 0) {
      progress.skipReviewResults("no findings");
      progress.skipFix("no findings");
      progress.skipRerun("no findings");
    } else {
      progress.startReviewResults();
      const action = await selectReviewResultsAction(ctx, reviewResultsSummary);
      if (action === null) {
        await cancelSession();
        return;
      }

      session.postConsolidationAction = action;
      progress.completeReviewResults(buildPostConsolidationDetail(action));

      if (action === "document-only") {
        progress.skipFix("document only");
        progress.skipRerun("document only");
        saveSession(currentOutput.status === "blocked" ? "blocked" : "completed");
        deps.notifyInfo(
          ctx,
          "AI review documented without fixes",
          `${buildCompletionDetail(session, currentOutput, reviewTarget.target)} | report: ${findingsReportPath}`,
        );
        return;
      }

      if (action === "discuss-before-fixing") {
        progress.skipFix("discussion requested");
        progress.skipRerun("discussion requested");
        saveSession(currentOutput.status === "blocked" ? "blocked" : "completed");
        deps.notifyInfo(
          ctx,
          "AI review saved for discussion",
          `${buildCompletionDetail(session, currentOutput, reviewTarget.target)} | report: ${findingsReportPath}`,
        );
        platform.sendUserMessage(
          buildDiscussionPrompt(platform, ctx, session, reviewResultsSummary, reviewTarget.target),
        );
        return;
      }

      progress.startFix();
      const initialFix = await deps.runAutoFix({
        cwd: ctx.cwd,
        scope,
        findings: currentOutput.findings,
        createAgentSession: platform.createAgentSession.bind(platform),
        model: resolvedModel.model,
        thinkingLevel: resolvedModel.thinkingLevel,
      });
      session.fixes.push(...initialFix.output.fixes);
      findingsReportIsPreFixSnapshot = initialFix.output.fixes.some((record) => record.status === "applied");
      progress.completeFix(initialFix.output.status);

      const reviewLoop = await selectYesNo(
        ctx,
        "Run review loop?",
        "If you continue, supipowers will re-run the same review after the fixes, validate findings again, refresh the findings.md report, and keep going until the findings are cleared or the iteration limit is reached.",
      );
      if (reviewLoop === null) {
        await cancelSession();
        return;
      }

      if (reviewLoop) {
        session.maxIterations = await selectMaxIterations(ctx, 3) ?? 3;
        let previousOutput = currentOutput;

        for (let iteration = 2; iteration <= session.maxIterations; iteration += 1) {
          progress.startRerun(iteration, session.maxIterations);
          const rerun = await runReviewPass(platform, ctx, deps, scope, level, agents, progress, resolvedModel);
          let rerunOutput = rerun.rawOutput;

          if (rerunOutput.findings.length > 0) {
            progress.startValidate();
            const validation = await deps.validateReviewFindings({
              cwd: ctx.cwd,
              scope,
              findings: rerunOutput.findings,
              createAgentSession: platform.createAgentSession.bind(platform),
              model: resolvedModel.model,
              thinkingLevel: resolvedModel.thinkingLevel,
            });
            const validatedOutput = preserveBlockedReviewStatus(validation.output, rerunOutput.status);
            rerunOutput = prepareReviewOutputForFollowUp(validatedOutput, rerunOutput.status);
            progress.completeValidate(validatedOutput);
          }

          if (session.consolidate && rerunOutput.findings.length > 0) {
            progress.startConsolidate();
            rerunOutput = prepareReviewOutputForFollowUp(
              deps.consolidateReviewOutputs([rerunOutput]),
              rerunOutput.status,
            );
            progress.completeConsolidate(rerunOutput);
          }

          const delta = compareReviewOutputs(previousOutput, rerunOutput);
          persistIteration(
            deps,
            platform,
            ctx,
            session,
            iteration,
            rerunOutput,
            reviewTarget.target,
            { delta },
          );
          findingsReportPath = writeFindingsReport(
            deps,
            platform,
            ctx,
            session,
            rerunOutput,
            reviewTarget.target,
          );
          findingsReportIsPreFixSnapshot = false;
          progress.completeRerun(iteration, session.maxIterations);

          previousOutput = rerunOutput;

          if (rerunOutput.findings.length === 0) {
            currentOutput = rerunOutput;
            break;
          }

          progress.startFix();
          const loopFix = await deps.runAutoFix({
            cwd: ctx.cwd,
            scope,
            findings: rerunOutput.findings,
            createAgentSession: platform.createAgentSession.bind(platform),
            model: resolvedModel.model,
            thinkingLevel: resolvedModel.thinkingLevel,
          });
          session.fixes.push(...loopFix.output.fixes);
          findingsReportIsPreFixSnapshot = loopFix.output.fixes.some((record) => record.status === "applied");
          progress.completeFix(loopFix.output.status);
          currentOutput = rerunOutput;
        }
      } else {
        progress.skipRerun("not requested");
      }
    }

    if (findingsReportIsPreFixSnapshot) {
      findingsReportPath = writeFindingsReport(
        deps,
        platform,
        ctx,
        session,
        currentOutput,
        reviewTarget.target,
        { preFixSnapshot: true },
      );
    }

    saveSession(currentOutput.status === "blocked" ? "blocked" : "completed");
    deps.notifyInfo(
      ctx,
      `AI review complete: ${findingsReportIsPreFixSnapshot ? "post-fix verification pending" : currentOutput.status}`,
      `${buildCompletionDetail(session, currentOutput, reviewTarget.target)} | report: ${findingsReportIsPreFixSnapshot ? `${findingsReportPath} (pre-fix snapshot)` : findingsReportPath}`,
    );
  } catch (error) {
    session.status = "blocked";
    deps.updateReviewSession(platform.paths, ctx.cwd, session, reviewTarget.target);
    progress.failActive((error as Error).message);
    throw error;
  } finally {
    progress.dispose();
  }
}

export function handleAiReview(platform: Platform, ctx: any, args?: string): void {
  void runAiReviewSession(platform, ctx, AI_REVIEW_COMMAND_DEPENDENCIES, args).catch((error) => {
    ctx.ui.notify(`AI review failed: ${(error as Error).message}`, "error");
  });
}

export async function runAiReviewSessionForTest(
  platform: Platform,
  ctx: any,
  deps: AiReviewCommandDependencies,
  args?: string,
): Promise<void> {
  await runAiReviewSession(platform, ctx, deps, args);
}

export function registerAiReviewCommand(platform: Platform): void {
  platform.registerCommand("supi:review", {
    description: "Run the AI code review pipeline",
    async handler(args: string | undefined, ctx: any) {
      handleAiReview(platform, ctx, args);
    },
  });
}
