import type { Platform } from "../platform/types.js";
import { createWorkflowProgress } from "../platform/progress.js";
import { notifyInfo } from "../notifications/renderer.js";
import { modelRegistry } from "../config/model-registry-instance.js";
import { createModelBridge, resolveModelForAction } from "../config/model-resolver.js";
import { loadModelConfig } from "../config/model-config.js";
import { selectReviewScope } from "../review/scope.js";
import { loadReviewAgents } from "../review/agent-loader.js";
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
import type {
  ConfiguredReviewAgent,
  ReviewLevel,
  ReviewOutput,
  ReviewScope,
  ReviewSession,
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

type ReviewSessionPhase = "raw" | "validated" | "consolidated";

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
  loadReviewAgents: typeof loadReviewAgents;
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
  loadReviewAgents,
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
    completeRerun(output: ReviewOutput) {
      complete("rerun", `${output.findings.length} finding(s)`);
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
    autoFix: false,
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

function buildCompletionDetail(session: ReviewSession, output: ReviewOutput): string {
  return [
    `session: ${session.id}`,
    `status: ${output.status}`,
    `findings: ${output.findings.length}`,
    `iterations: ${session.currentIteration}`,
  ].join(" | ");
}

function persistIteration(
  deps: AiReviewCommandDependencies,
  platform: Platform,
  ctx: any,
  session: ReviewSession,
  iteration: number,
  output: ReviewOutput,
  extra: Record<string, unknown> = {},
): void {
  const relativePath = `${ITERATIONS_DIR}/${iteration}.json`;
  deps.writeReviewArtifact(platform.paths, ctx.cwd, session.id, relativePath, {
    output,
    ...extra,
  });
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
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("/supi:review requires interactive mode.", "warning");
    return;
  }

  const scope = await deps.selectReviewScope(platform, ctx);
  if (!scope) {
    return;
  }

  const level = await selectReviewLevel(ctx);
  if (!level) {
    return;
  }

  const loadedAgents = level === "multi-agent"
    ? await deps.loadReviewAgents(platform.paths, ctx.cwd)
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
  deps.createReviewSession(platform.paths, ctx.cwd, session);
  deps.writeReviewArtifact(platform.paths, ctx.cwd, session.id, session.artifacts.scope, scope);

  const progress = createAiReviewProgress(ctx, level, agents);
  progress.completeScope(scope);

  async function cancelSession(): Promise<void> {
    progress.startSave();
    session.status = "cancelled";
    deps.updateReviewSession(platform.paths, ctx.cwd, session);
    progress.completeSave("cancelled");
  }

  try {
    const initialRun = await runReviewPass(platform, ctx, deps, scope, level, agents, progress, resolvedModel);
    deps.writeReviewArtifact(platform.paths, ctx.cwd, session.id, RAW_FINDINGS_FILE, initialRun.rawOutput);
    session.artifacts.rawFindings = RAW_FINDINGS_FILE;
    for (const agentResult of initialRun.agentResults) {
      deps.writeReviewArtifact(
        platform.paths,
        ctx.cwd,
        session.id,
        `${AGENTS_DIR}/${agentResult.agent.name}.json`,
        agentResult,
      );
    }

    let currentOutput = initialRun.rawOutput;

    const validate = currentOutput.findings.length > 0
      ? await selectYesNo(
          ctx,
          "Validate findings?",
          "Cross-reference findings against actual code before continuing.",
        )
      : false;
    if (validate === null) {
      await cancelSession();
      return;
    }
    session.validateFindings = Boolean(validate);
    if (validate) {
      progress.startValidate();
      const validation = await deps.validateReviewFindings({
        cwd: ctx.cwd,
        scope,
        findings: currentOutput.findings,
        createAgentSession: platform.createAgentSession.bind(platform),
        model: resolvedModel.model,
        thinkingLevel: resolvedModel.thinkingLevel,
      });
      currentOutput = validation.output;
      deps.writeReviewArtifact(platform.paths, ctx.cwd, session.id, VALIDATED_FINDINGS_FILE, currentOutput);
      session.artifacts.validatedFindings = VALIDATED_FINDINGS_FILE;
      progress.completeValidate(currentOutput);
    } else {
      progress.skipValidate(currentOutput.findings.length === 0 ? "no findings" : "not requested");
    }

    const consolidate = level === "multi-agent"
      ? await selectYesNo(
          ctx,
          "Consolidate findings?",
          "Merge overlapping findings from all agents into a single report.",
        )
      : false;
    if (consolidate === null) {
      await cancelSession();
      return;
    }
    session.consolidate = Boolean(consolidate);
    if (level !== "multi-agent") {
      progress.skipConsolidate("single-agent");
    } else if (consolidate) {
      progress.startConsolidate();
      currentOutput = deps.consolidateReviewOutputs([currentOutput]);
      deps.writeReviewArtifact(platform.paths, ctx.cwd, session.id, CONSOLIDATED_FINDINGS_FILE, currentOutput);
      session.artifacts.consolidatedFindings = CONSOLIDATED_FINDINGS_FILE;
      progress.completeConsolidate(currentOutput);
    } else {
      progress.skipConsolidate(currentOutput.findings.length === 0 ? "no findings" : "not requested");
    }

    persistIteration(deps, platform, ctx, session, 1, currentOutput);

    const autoFix = currentOutput.findings.length > 0
      ? await selectYesNo(
          ctx,
          "Fix automatically?",
          "Attempt safe automatic fixes for the current findings.",
        )
      : false;
    if (autoFix === null) {
      await cancelSession();
      return;
    }
    session.autoFix = Boolean(autoFix);

    if (autoFix) {
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
      progress.completeFix(initialFix.output.status);

      const reviewLoop = currentOutput.findings.length > 0
        ? await selectYesNo(
            ctx,
            "Run review loop?",
            "Re-run the same review after fixes and continue up to a limit.",
          )
        : false;
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

          if (session.validateFindings && rerunOutput.findings.length > 0) {
            progress.startValidate();
            const validation = await deps.validateReviewFindings({
              cwd: ctx.cwd,
              scope,
              findings: rerunOutput.findings,
              createAgentSession: platform.createAgentSession.bind(platform),
              model: resolvedModel.model,
              thinkingLevel: resolvedModel.thinkingLevel,
            });
            rerunOutput = validation.output;
            progress.completeValidate(rerunOutput);
          }

          if (session.consolidate && rerunOutput.findings.length > 0) {
            progress.startConsolidate();
            rerunOutput = deps.consolidateReviewOutputs([rerunOutput]);
            progress.completeConsolidate(rerunOutput);
          }

          const delta = compareReviewOutputs(previousOutput, rerunOutput);
          persistIteration(deps, platform, ctx, session, iteration, rerunOutput, { delta });
          progress.completeRerun(rerunOutput);
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
          progress.completeFix(loopFix.output.status);
          currentOutput = rerunOutput;
        }
      } else {
        progress.skipRerun("not requested");
      }
    } else {
      progress.skipFix(currentOutput.findings.length === 0 ? "no findings" : "not requested");
      progress.skipRerun("fix disabled");
    }

    progress.startSave();
    session.status = currentOutput.status === "blocked" ? "blocked" : "completed";
    deps.updateReviewSession(platform.paths, ctx.cwd, session);
    progress.completeSave(session.status);
    deps.notifyInfo(ctx, `AI review complete: ${currentOutput.status}`, buildCompletionDetail(session, currentOutput));
  } catch (error) {
    session.status = "blocked";
    deps.updateReviewSession(platform.paths, ctx.cwd, session);
    progress.failActive((error as Error).message);
    throw error;
  } finally {
    progress.dispose();
  }
}

export function handleAiReview(platform: Platform, ctx: any): void {
  void runAiReviewSession(platform, ctx, AI_REVIEW_COMMAND_DEPENDENCIES).catch((error) => {
    ctx.ui.notify(`AI review failed: ${(error as Error).message}`, "error");
  });
}

export async function runAiReviewSessionForTest(
  platform: Platform,
  ctx: any,
  deps: AiReviewCommandDependencies,
): Promise<void> {
  await runAiReviewSession(platform, ctx, deps);
}

export function registerAiReviewCommand(platform: Platform): void {
  platform.registerCommand("supi:review", {
    description: "Run the AI code review pipeline",
    async handler(_args: string | undefined, ctx: any) {
      handleAiReview(platform, ctx);
    },
  });
}
