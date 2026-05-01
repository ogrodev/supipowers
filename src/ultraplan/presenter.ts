import type {
  UltraPlanAuthoringPipelineEvent,
  UltraPlanAuthoringStage,
  UltraPlanAuthoringState,
  UltraPlanAuthoredArtifact,
  UltraPlanBlocker,
  UltraPlanSessionSummary,
  UltraPlanStack,
} from "../types.js";
import type { UltraPlanRunOutcome } from "./execution/session-runner.js";
import type { UltraPlanSessionRecommendation } from "./next-router.js";
import {
  isDraftReadyToPersist,
  type UltraPlanAuthoredDraft,
} from "./authoring-draft.js";
import {
  getUltraPlanIdleReasonLabel,
  resolveUltraPlanSessionBucket,
  type UltraPlanResolvedCursor,
  type UltraPlanVisibleSession,
} from "./session-selection.js";

export interface UltraPlanPickerOption {
  value: string;
  label: string;
  description: string;
}

export function buildUltraPlanPickerOptions(
  sessions: UltraPlanVisibleSession[],
  recommendations?: ReadonlyMap<string, UltraPlanSessionRecommendation>,
): UltraPlanPickerOption[] {
  return sessions.map((session) => ({
    value: session.sessionId,
    label: `[${session.bucket}] ${formatInlineSessionTitle(session.title)}`,
    description: describePickerDescription(session, recommendations?.get(session.sessionId)),
  }));
}

function formatInlineSessionTitle(title: string): string {
  return title
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function describePickerDescription(
  session: UltraPlanVisibleSession,
  recommendation?: UltraPlanSessionRecommendation,
): string {
  const base = describePickerSession(session);
  if (!recommendation) return base;
  return `${describePickerRecommendation(recommendation)} — ${base}`;
}

function describePickerSession(session: UltraPlanVisibleSession): string {
  if (isSlice2SurfacedBlocker(session.blocker)) {
    const idle = session.idleReasonLabel ?? `Blocked: ${session.blocker.message}`;
    return `${idle} — ${session.blocker.code} (${session.blocker.recoveryMode})`;
  }
  if (session.idleReasonLabel) return `Idle: ${session.idleReasonLabel}`;
  return `Current: ${session.cursor?.summary ?? "No active cursor"}`;
}

export function renderUltraPlanRecommendationSummary(
  recommendation: UltraPlanSessionRecommendation,
): string {
  return `Recommended next: ${formatInlineSessionTitle(recommendation.session.title)} — ${describeRecommendationSummary(recommendation)}`;
}

export function renderUltraPlanRecommendationStatusLine(
  recommendation: UltraPlanSessionRecommendation,
): string {
  return `Ultraplan next: ${formatInlineSessionTitle(recommendation.session.title)} — ${describeRecommendationStatus(recommendation)}`;
}

function describePickerRecommendation(
  recommendation: UltraPlanSessionRecommendation,
): string {
  switch (recommendation.reasonCode) {
    case "ongoing":
      return "Recommended next to run";
    case "pending":
      return "Ready to run";
    case "awaiting-user":
    case "mismatch":
      return "Inspect before running";
    case "blocked-manual":
      return "Action needed";
    case "blocked":
      return "Blocked";
  }
}

function describeRecommendationSummary(
  recommendation: UltraPlanSessionRecommendation,
): string {
  switch (recommendation.reasonCode) {
    case "ongoing":
      return "resume the in-progress session.";
    case "pending":
      return "ready to run.";
    case "awaiting-user":
      return "inspect it first; user input is required.";
    case "blocked-manual":
      return "action needed before it can resume.";
    case "blocked":
      return "inspect it first; it is blocked.";
    case "mismatch":
      return "inspect it first; session state is inconsistent.";
  }
}

function describeRecommendationStatus(
  recommendation: UltraPlanSessionRecommendation,
): string {
  switch (recommendation.reasonCode) {
    case "ongoing":
      return "resume now";
    case "pending":
      return "ready to run";
    case "awaiting-user":
      return "waiting for user input";
    case "blocked-manual":
      return "action needed";
    case "blocked":
      return "blocked";
    case "mismatch":
      return "inspect session";
  }
}

export function renderUltraPlanStatus(
  session: UltraPlanSessionSummary,
  authored: UltraPlanAuthoredArtifact,
  resolved: UltraPlanResolvedCursor,
): string {
  const bucket = resolveUltraPlanSessionBucket(session, resolved);
  const idleReason = getUltraPlanIdleReasonLabel(session);
  const stackProgress = session.stacks.length > 0
    ? session.stacks.map((stack) => `${stack.stack} ${stack.terminalDomainCount}/${stack.domainCount} domains terminal`).join("; ")
    : "—";
  const domainProgress = formatDomainProgress(authored, resolved);

  const lines = [
    `Title: ${session.title}`,
    `Goal: ${authored.goal}`,
    `State: ${session.state}`,
    `Bucket: ${bucket}`,
    `Current: ${resolved.cursor.summary}`,
    `Current source: ${resolved.source}`,
    `Last completed (persisted): ${session.lastCompleted?.summary ?? "—"}`,
    `Stack progress (persisted): ${stackProgress}`,
    `Domain progress: ${domainProgress}`,
  ];

  if (idleReason) {
    lines.push(`Idle reason: ${idleReason}`);
  }
  if (isSlice2SurfacedBlocker(session.blocker)) {
    lines.push(`Blocker: ${session.blocker.code}`);
    lines.push(`Recovery: ${session.blocker.recoveryMode}`);
    lines.push(`Next action: ${session.blocker.nextAction}`);
  } else if (!idleReason && resolved.cursor.targetType === "session" && resolved.cursor.status === "complete") {
    lines.push("Next action: None — session complete");
  } else if (!idleReason) {
    lines.push(`Next action: Resume ${resolved.cursor.summary}`);
  }

  return lines.join("\n");
}

export function renderUltraPlanRunOutcome(outcome: UltraPlanRunOutcome): string {
  if (outcome.kind === "completed") {
    return [
      `Completed: ${outcome.session.title}`,
      `Current: ${outcome.session.cursor?.summary ?? "Session complete"}`,
    ].join("\n");
  }

  const blockerMessage = outcome.session.blocker?.message
    ?? outcome.session.cursor?.summary
    ?? "Paused";
  const prefix = outcome.session.state === "awaiting-user" ? "Awaiting user" : "Paused";

  return [
    `${prefix}: ${outcome.session.title}`,
    blockerMessage,
  ].join("\n");
}

function formatDomainProgress(authored: UltraPlanAuthoredArtifact, resolved: UltraPlanResolvedCursor): string {
  const stackId = resolved.cursor.stack;
  const domainId = resolved.cursor.domainId;
  if (!stackId || !domainId) {
    return "—";
  }

  const stack = authored.stacks.find((candidate) => candidate.stack === stackId);
  const domain = stack?.domains.find((candidate) => candidate.id === domainId);
  if (!domain) {
    return "—";
  }

  const scenarios = [...domain.unit, ...domain.integration, ...domain.e2e];
  const terminalCount = scenarios.filter((scenario) =>
    scenario.status === "green-proved"
      || scenario.status === "review-passed"
      || scenario.status === "done").length;

  return `${domain.id} ${terminalCount}/${scenarios.length} scenarios terminal`;
}

const SLICE_2_SURFACED_BLOCKER_CODES: readonly string[] = [
  "migration-unsafe",
  "migration-conflict",
  "interrupted-attempt",
];

/**
 * Slice-2 migration and interrupted-attempt blockers carry recovery metadata (recoveryMode,
 * nextAction) that the picker and status surfaces must expose. Other blockers (legacy
 * session-level codes) continue to use the generic idle-reason path.
 */
function isSlice2SurfacedBlocker(blocker: UltraPlanBlocker | null): blocker is UltraPlanBlocker {
  return blocker !== null && SLICE_2_SURFACED_BLOCKER_CODES.includes(blocker.code);
}

export function renderUltraPlanAuthoredDraft(draft: UltraPlanAuthoredDraft): string[] {
  const lines: string[] = [
    `Session: ${draft.title}`,
    `Goal: ${draft.goal}`,
  ];

  for (const stack of draft.stacks) {
    lines.push("");
    if (stack.applicability === "not-applicable") {
      lines.push(`## ${stack.stack} (not-applicable)`);
      continue;
    }
    renderApplicableStack(lines, stack);
  }

  const readiness = isDraftReadyToPersist(draft);
  if (!readiness.ok) {
    lines.push("");
    lines.push("Readiness blockers:");
    for (const blocker of readiness.blockers) {
      lines.push(`  - ${describeBlocker(blocker)}`);
    }
  }

  return lines;
}

function renderApplicableStack(lines: string[], stack: UltraPlanStack): void {
  lines.push(`## ${stack.stack} (applicable)`);
  lines.push(`  executor: ${stack.agentSlots.executor.agentName}`);
  lines.push(`  tester: ${stack.agentSlots.tester.agentName}`);
  if (stack.agentSlots.domainReviewer) {
    lines.push(`  domain reviewer: ${stack.agentSlots.domainReviewer.agentName}`);
  }
  if (stack.agentSlots.stackReviewer) {
    lines.push(`  stack reviewer: ${stack.agentSlots.stackReviewer.agentName}`);
  }

  for (const domain of stack.domains) {
    lines.push("");
    lines.push(`  Domain: ${domain.id} — ${domain.name}`);
    for (const level of ["unit", "integration", "e2e"] as const) {
      const scenarios = domain[level];
      if (scenarios.length === 0) {
        lines.push(`    ${level}: —`);
        continue;
      }
      lines.push(`    ${level}:`);
      for (const scenario of scenarios) {
        lines.push(`      - ${scenario.id}: ${scenario.title}`);
      }
    }
  }
}

function describeBlocker(blocker: { code: string; stack?: string; domainId?: string; slot?: string }): string {
  switch (blocker.code) {
    case "empty-session":
      return "No applicable stacks (edit applicability)";
    case "empty-applicable-stack":
      return `${blocker.stack} has no domains (edit ${blocker.stack}.domains)`;
    case "empty-domain":
      return `${blocker.stack}.${blocker.domainId} has no scenarios (edit ${blocker.stack}.${blocker.domainId}.scenarios)`;
    case "missing-required-slot":
      return `${blocker.stack} is missing required slot ${blocker.slot}`;
    default:
      return blocker.code;
  }
}

/**
 * Render the multi-stage authoring pipeline status for a session whose manifest carries an
 * `authoring` block. Mirrors `renderUltraPlanStatus`'s line-oriented format.
 */
export function renderUltraPlanAuthoringStatus(
  sessionId: string,
  state: UltraPlanAuthoringState,
  events: UltraPlanAuthoringPipelineEvent[] = [],
): string {
  const lines: string[] = [
    `Session: ${sessionId}`,
    `Pipeline: ${state.pipeline}`,
    `Stage: ${state.stage}`,
    `Status: ${state.stageStatus}`,
    `Iteration: ${state.iteration}`,
  ];
  if (state.stallReentryCount > 0) {
    lines.push(`Stall re-entries: ${state.stallReentryCount}`);
  }
  const artifactKeys = Object.entries(state.artifacts)
    .filter(([, v]) => v !== undefined && v !== null && (Array.isArray(v) ? v.length > 0 : true))
    .map(([k]) => k);
  lines.push(`Artifacts: ${artifactKeys.length === 0 ? "\u2014" : artifactKeys.join(", ")}`);
  lines.push(`Started: ${state.startedAt}`);
  lines.push(`Updated: ${state.updatedAt}`);
  if (state.blocker) {
    lines.push(`Blocker: ${state.blocker.code} \u2014 ${state.blocker.message}`);
    lines.push(`Recovery: ${state.blocker.recoveryMode}`);
  }
  lines.push(`Next action: ${describeNextAuthoringAction(state)}`);
  if (events.length > 0) {
    lines.push("");
    lines.push("Recent pipeline events:");
    for (const ev of events.slice(-5)) {
      lines.push(`  ${ev.recordedAt} [${ev.stage}/${ev.stageStatus}] ${ev.summary || ""}`.trimEnd());
    }
  }
  return lines.join("\n");
}

function describeNextAuthoringAction(state: UltraPlanAuthoringState): string {
  if (state.blocker) return `Resolve blocker ${state.blocker.code}`;
  if (state.stageStatus === "awaiting-user") return `Confirm ${state.stage} to advance`;
  if (state.stageStatus === "running") return `Resume ${state.stage}`;
  if (state.stageStatus === "blocked") return `Repair ${state.stage} blocker`;
  const next = nextStageOf(state.stage);
  if (!next) return "Approval pending";
  return `Run ${next}`;
}

function nextStageOf(stage: UltraPlanAuthoringStage): UltraPlanAuthoringStage | null {
  switch (stage) {
    case "intake": return "scout";
    case "scout": return "discover";
    case "discover": return "research";
    case "research": return "synthesize";
    case "synthesize": return "review";
    case "review": return "approve";
    case "approve": return null;
  }
}