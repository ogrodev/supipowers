import type {
  ResolvedUltraPlanSlotBinding,
  UltraPlanLaunchContext,
} from "../../types.js";
import {
  injectLaunchContextIntoPrompt,
  injectTargetHintIntoPrompt,
  LAUNCH_CONTEXT_METADATA_KEY,
  TARGET_HINT_METADATA_KEY,
} from "../runtime/launch-context.js";
import type { UltraPlanExecutionTarget } from "./policy.js";

export interface BuildUltraPlanAttemptContractInput {
  slot: ResolvedUltraPlanSlotBinding;
  launchContext: UltraPlanLaunchContext;
  target: UltraPlanExecutionTarget;
  prompt: string;
}

export interface UltraPlanAttemptContract {
  slot: ResolvedUltraPlanSlotBinding;
  launchContext: UltraPlanLaunchContext;
  target: UltraPlanExecutionTarget;
  assignment: string;
  metadata: Record<string, unknown>;
}

export function buildUltraPlanAttemptContract(input: BuildUltraPlanAttemptContractInput): UltraPlanAttemptContract {
  if (input.target.requiredSlot && input.slot.slot !== input.target.requiredSlot) {
    throw new Error(
      `UltraPlan attempt contract slot mismatch: expected ${input.target.requiredSlot}, received ${input.slot.slot}`,
    );
  }

  const targetHint = {
    targetType: input.target.targetType,
    stack: input.target.stack,
    domainId: input.target.domainId,
    level: input.target.level,
    scenarioId: input.target.scenarioId,
    phase: input.target.phase,
    resolvedSlot: input.target.requiredSlot,
    actorKind: "slot" as const,
    sourceAgent: "sub-agent" as const,
  };
  const metadata = {
    [LAUNCH_CONTEXT_METADATA_KEY]: input.launchContext,
    [TARGET_HINT_METADATA_KEY]: targetHint,
  } satisfies Record<string, unknown>;

  const assignmentSections = [
    input.prompt.trim(),
    `Reserved slot: ${input.slot.slot}`,
    `Attempt target: ${input.target.summary}`,
    `Phase: ${input.target.phase}`,
    "TDD ownership: own exactly this reserved-slot attempt. In red, establish the failing proof. In green, make the authored target pass with the smallest truthful change. In review, validate and write the required review artifact.",
    "No nested sub-agents. Do not delegate, spawn task agents, batch multiple targets, or widen scope beyond this target.",
    input.target.reviewArtifactPath ? `Review artifact path: ${input.target.reviewArtifactPath}` : null,
  ].filter((section): section is string => section !== null && section.length > 0);

  const assignmentWithLaunchContext = injectLaunchContextIntoPrompt(assignmentSections.join("\n\n"), input.launchContext);
  const assignment = injectTargetHintIntoPrompt(assignmentWithLaunchContext, targetHint);

  return {
    slot: input.slot,
    launchContext: input.launchContext,
    target: input.target,
    assignment,
    metadata,
  };
}
