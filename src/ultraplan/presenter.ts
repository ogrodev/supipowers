import type { UltraPlanAuthoredArtifact, UltraPlanSessionSummary } from "../types.js";
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
    description: session.idleReasonLabel
      ? `Idle: ${session.idleReasonLabel}`
      : `Current: ${session.cursor?.summary ?? "No active cursor"}`,
  }));
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
  } else if (resolved.cursor.targetType === "session" && resolved.cursor.status === "complete") {
    lines.push("Next action: None — session complete");
  } else {
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
