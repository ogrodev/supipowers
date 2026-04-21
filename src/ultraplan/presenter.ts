import type {
  UltraPlanAuthoredArtifact,
  UltraPlanBlocker,
  UltraPlanSessionSummary,
  UltraPlanStack,
} from "../types.js";
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

export function buildUltraPlanPickerOptions(sessions: UltraPlanVisibleSession[]): UltraPlanPickerOption[] {
  return sessions.map((session) => ({
    value: session.sessionId,
    label: `[${session.bucket}] ${session.title}`,
    description: describePickerSession(session),
  }));
}

function describePickerSession(session: UltraPlanVisibleSession): string {
  if (isSlice2SurfacedBlocker(session.blocker)) {
    const idle = session.idleReasonLabel ?? `Blocked: ${session.blocker.message}`;
    return `${idle} — ${session.blocker.code} (${session.blocker.recoveryMode})`;
  }
  if (session.idleReasonLabel) return `Idle: ${session.idleReasonLabel}`;
  return `Current: ${session.cursor?.summary ?? "No active cursor"}`;
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