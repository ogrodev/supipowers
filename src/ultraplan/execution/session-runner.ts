import type { Platform } from "../../platform/types.js";
import type {
  ResolvedUltraPlanSlotBinding,
  UltraPlanAgentBinding,
  UltraPlanAgentSlotName,
  UltraPlanAuthoredArtifact,
  UltraPlanSessionSummary,
} from "../../types.js";
import {
  loadUltraPlanAuthoredArtifact,
  loadUltraPlanManifest,
  loadUltraPlanSessionSummary,
} from "../storage.js";
import { resolveNextExecutionTarget } from "./policy.js";
import { buildUltraPlanAttemptContract } from "./contract.js";
import { mintLaunchContext } from "../runtime/launch-context.js";
import {
  bindActiveUltraPlanExecution,
  clearActiveUltraPlanExecution,
  type ActiveUltraPlanExecution,
} from "../runtime/active-execution.js";

export type UltraPlanRunOutcome =
  | { kind: "paused"; session: UltraPlanSessionSummary }
  | { kind: "completed"; session: UltraPlanSessionSummary };

export type UltraPlanRunState =
  | { kind: "attempt"; execution: ActiveUltraPlanExecution }
  | { kind: "outcome"; outcome: UltraPlanRunOutcome };

export interface RunUltraPlanSessionInput {
  platform: Platform;
  cwd: string;
  sessionId: string;
  deps?: Partial<RunUltraPlanSessionDeps>;
}

export interface RunUltraPlanSessionDeps {
  resolveRunState(input: RunUltraPlanSessionInput): Promise<UltraPlanRunState> | UltraPlanRunState;
  dispatch(
    execution: ActiveUltraPlanExecution,
    input: RunUltraPlanSessionInput,
  ): Promise<void> | void;
}

export async function runUltraPlanSession(input: RunUltraPlanSessionInput): Promise<UltraPlanRunOutcome> {
  const deps = buildDeps(input.deps);

  while (true) {
    const runState = await deps.resolveRunState(input);
    if (runState.kind === "outcome") {
      return runState.outcome;
    }

    bindActiveUltraPlanExecution(runState.execution);
    try {
      await deps.dispatch(runState.execution, input);
    } finally {
      clearActiveUltraPlanExecution();
    }
  }
}

function buildDeps(overrides: RunUltraPlanSessionInput["deps"]): RunUltraPlanSessionDeps {
  return {
    resolveRunState: overrides?.resolveRunState ?? defaultResolveRunState,
    dispatch: overrides?.dispatch ?? defaultDispatch,
  };
}

function defaultResolveRunState(input: RunUltraPlanSessionInput): UltraPlanRunState {
  const summaryResult = loadUltraPlanSessionSummary(input.platform.paths, input.cwd, input.sessionId);
  assertStorageResult(summaryResult);
  const summary = summaryResult.value;

  if (summary.state === "blocked" || summary.state === "awaiting-user") {
    return { kind: "outcome", outcome: { kind: "paused", session: summary } };
  }

  const authoredResult = loadUltraPlanAuthoredArtifact(input.platform.paths, input.cwd, input.sessionId);
  assertStorageResult(authoredResult);
  const manifestResult = loadUltraPlanManifest(input.platform.paths, input.cwd, input.sessionId);
  assertStorageResult(manifestResult);

  const target = resolveNextExecutionTarget({
    paths: input.platform.paths,
    cwd: input.cwd,
    authored: authoredResult.value,
    manifest: manifestResult.value,
  });

  if (target.targetType === "session") {
    return {
      kind: "outcome",
      outcome: {
        kind: "completed",
        session: {
          ...summary,
          state: "complete",
          cursor: target,
          blocker: null,
        },
      },
    };
  }

  if (!target.requiredSlot || target.phase === "waiting" || target.status === "blocked") {
    return {
      kind: "outcome",
      outcome: {
        kind: "paused",
        session: buildPausedSession(summary, target),
      },
    };
  }

  const slotBinding = resolveSlotBinding(authoredResult.value, target.requiredSlot);
  if (!slotBinding) {
    return {
      kind: "outcome",
      outcome: {
        kind: "paused",
        session: buildPausedSession(summary, target, `Reserved slot ${target.requiredSlot} is not configured for this session.`),
      },
    };
  }

  return {
    kind: "attempt",
    execution: {
      sessionId: input.sessionId,
      cwd: input.cwd,
      target,
      launchContext: mintLaunchContext({
        attemptKey: buildAttemptKey(target),
        sourceAgent: "sub-agent",
        nowIso: new Date().toISOString(),
      }),
      slotBinding,
    },
  };
}

async function defaultDispatch(execution: ActiveUltraPlanExecution, input: RunUltraPlanSessionInput): Promise<void> {
  const slotBinding = execution.slotBinding ?? synthesizeSlotBinding(execution.target.requiredSlot);
  if (!slotBinding) {
    throw new Error("UltraPlan dispatch requires a reserved slot binding");
  }

  const contract = buildUltraPlanAttemptContract({
    slot: slotBinding,
    launchContext: execution.launchContext,
    target: execution.target,
    prompt: buildDispatchPrompt(execution),
  });

  const session = await input.platform.createAgentSession({
    cwd: input.cwd,
    ...(slotBinding.model ? { model: slotBinding.model } : {}),
    ...(slotBinding.thinkingLevel ? { thinkingLevel: slotBinding.thinkingLevel } : {}),
  });

  try {
    await session.prompt(contract.assignment, { expandPromptTemplates: false });
  } finally {
    await session.dispose();
  }
}

function resolveSlotBinding(
  authored: UltraPlanAuthoredArtifact,
  requiredSlot: UltraPlanAgentSlotName,
): ResolvedUltraPlanSlotBinding | null {
  for (const stack of authored.stacks) {
    const candidates: Array<UltraPlanAgentBinding | undefined> = [
      stack.agentSlots.executor,
      stack.agentSlots.tester,
      stack.agentSlots.domainReviewer,
      stack.agentSlots.stackReviewer,
    ];
    const binding = candidates.find((candidate) => candidate?.slot === requiredSlot);
    if (binding) {
      return toResolvedSlotBinding(binding);
    }
  }

  return null;
}

function toResolvedSlotBinding(binding: UltraPlanAgentBinding): ResolvedUltraPlanSlotBinding {
  return {
    slot: binding.slot,
    agentType: binding.agentType,
    agentName: binding.agentName,
    model: binding.model,
    thinkingLevel: binding.thinkingLevel,
    selectionSource: "default",
    definitionSource: binding.agentType === "built-in" ? "built-in" : "global",
    modelSource: binding.model ? "project" : "unset",
    thinkingLevelSource: binding.thinkingLevel ? "project" : "unset",
    definitionPath: null,
  };
}

function synthesizeSlotBinding(requiredSlot: UltraPlanAgentSlotName | null): ResolvedUltraPlanSlotBinding | null {
  if (!requiredSlot) {
    return null;
  }

  return {
    slot: requiredSlot,
    agentType: "built-in",
    agentName: requiredSlot,
    model: null,
    thinkingLevel: null,
    selectionSource: "default",
    definitionSource: "built-in",
    modelSource: "unset",
    thinkingLevelSource: "unset",
    definitionPath: null,
  };
}

function buildDispatchPrompt(execution: ActiveUltraPlanExecution): string {
  return [
    `Execute the reserved UltraPlan target: ${execution.target.summary}`,
    "Work only this target in strict order and report the outcome via ultraplan_signal.",
  ].join("\n\n");
}

function buildAttemptKey(target: ActiveUltraPlanExecution["target"]): string {
  if (target.targetType === "scenario") {
    return `${target.stack}/${target.domainId}/${target.level}/${target.scenarioId}/${target.phase}`;
  }
  if (target.targetType === "domain-review") {
    return `${target.stack}/${target.domainId}/domain-review`;
  }
  if (target.targetType === "stack-review") {
    return `${target.stack}/stack-review`;
  }
  return "session/complete";
}

function buildPausedSession(
  summary: UltraPlanSessionSummary,
  target: ActiveUltraPlanExecution["target"],
  message = target.summary,
): UltraPlanSessionSummary {
  return {
    ...summary,
    state: target.status === "blocked" || target.phase === "waiting" ? "blocked" : summary.state,
    cursor: target,
    blocker: summary.blocker ?? {
      code: "persistence-failure",
      message,
      scope: "session",
      affected: {
        stack: target.stack,
        domainId: target.domainId,
        level: target.level,
        scenarioId: target.scenarioId,
      },
      recoverable: true,
      recoveryMode: "manual",
      nextAction: "Resolve the blocked target and rerun ultraplan.",
      retryable: false,
      detectedAt: new Date().toISOString(),
    },
  };
}

function assertStorageResult<T extends { ok: boolean; error?: { message: string; details?: string[] } }>(
  result: T,
): asserts result is T & { ok: true; value: Exclude<(T & { value?: unknown })["value"], undefined> } {
  if (result.ok) {
    return;
  }

  const detail = result.error?.details?.length ? `\n${result.error.details.join("\n")}` : "";
  throw new Error(`${result.error?.message ?? "UltraPlan storage failure"}${detail}`);
}
