import type { EventStore, TrackedEvent } from "../context-mode/event-store.js";
import { buildResumeSnapshot } from "../context-mode/snapshot-builder.js";

export interface SessionSummaryOptions {
  cwd: string;
  sessionId: string;
  wing: string;
  defaultAgentName: string;
  now?: string;
  eventStore?: Pick<EventStore, "getEventCounts" | "getEvents"> | null;
  sessionManager?: { getBranch?: () => unknown[] } | null;
  maxChars?: number;
}

export interface CompactionCheckpoint {
  content: string;
  metadata: {
    wing: string;
    room: "compaction-checkpoints";
    added_by: string;
    source_file: string;
  };
}

export interface ShutdownDiary {
  entry: string;
  metadata: {
    agent_name: string;
    wing: string;
    topic: "shutdown";
    timestamp: string;
    source_file: string;
  };
}

const DEFAULT_MAX_CHARS = 8000;
const EVENT_CATEGORIES = ["decision", "task", "intent", "rule"] as const;

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function safeParse(data: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(data);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function summarizeTask(data: Record<string, unknown>): string | null {
  const input = data.input as Record<string, unknown> | undefined;
  const ops = Array.isArray(input?.ops) ? input.ops as Array<Record<string, unknown>> : [];
  const parts = ops.map((op) => {
    const verb = typeof op.op === "string" ? op.op : "";
    const target = typeof op.task === "string" ? op.task : typeof op.phase === "string" ? op.phase : "";
    return [verb, target].filter(Boolean).join(": ");
  }).filter(Boolean);
  return parts.length > 0 ? parts.join("; ") : JSON.stringify(data).slice(0, 240);
}

function summarizeEvent(event: TrackedEvent): string | null {
  const data = safeParse(event.data);
  if (!data) return null;
  if (event.category === "decision") {
    const prompt = typeof data.prompt === "string" ? data.prompt.trim() : "";
    return prompt ? `decision: ${prompt}` : null;
  }
  if (event.category === "task") {
    const summary = summarizeTask(data);
    return summary ? `task: ${summary}` : null;
  }
  if (event.category === "intent") {
    const intent = typeof data.intent === "string" ? data.intent : "intent";
    const prompt = typeof data.prompt === "string" ? data.prompt : "";
    return `intent ${intent}: ${prompt}`.trim();
  }
  if (event.category === "rule") {
    const path = typeof data.path === "string" ? data.path : typeof data.file === "string" ? data.file : "";
    return path ? `rule loaded: ${path}` : null;
  }
  return null;
}

function eventStoreSection(options: SessionSummaryOptions): string | null {
  const eventStore = options.eventStore;
  if (!eventStore) return null;

  let snapshot = "";
  try {
    snapshot = buildResumeSnapshot(eventStore as EventStore, options.sessionId);
  } catch {
    snapshot = "";
  }

  const lines: string[] = [];
  try {
    const events = eventStore.getEvents(options.sessionId, { categories: [...EVENT_CATEGORIES], limit: 40 });
    for (const event of events) {
      const summary = summarizeEvent(event as TrackedEvent);
      if (summary) lines.push(`- ${summary}`);
    }
  } catch {
    // fall through to snapshot-only or later fallbacks
  }

  if (!snapshot && lines.length === 0) return null;
  return [
    "Event-store summary",
    snapshot,
    ...lines,
  ].filter(Boolean).join("\n");
}

function branchText(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (typeof entry !== "object" || entry === null) return null;
  const record = entry as Record<string, unknown>;
  const role = typeof record.role === "string" ? record.role : "entry";
  const content = record.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((part) => typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")
      .filter(Boolean)
      .join("\n");
  }
  return text ? `${role}: ${text}` : null;
}

function sessionManagerSection(options: SessionSummaryOptions): string | null {
  try {
    const branch = options.sessionManager?.getBranch?.();
    if (!Array.isArray(branch) || branch.length === 0) return null;
    const lines = branch.map(branchText).filter((line): line is string => Boolean(line)).slice(-10);
    return lines.length > 0 ? ["Session branch fallback", ...lines.map((line) => `- ${line}`)].join("\n") : null;
  } catch {
    return null;
  }
}

function fallbackSection(reason: "compaction" | "shutdown", options: SessionSummaryOptions, now: string): string {
  return [
    `timestamp: ${now}`,
    `cwd: ${options.cwd}`,
    `wing: ${options.wing}`,
    `session: ${options.sessionId}`,
    `reason: ${reason}`,
    "Structured session data unavailable.",
  ].join("\n");
}

function buildBody(title: string, reason: "compaction" | "shutdown", options: SessionSummaryOptions): { body: string; now: string } {
  const now = options.now ?? new Date().toISOString();
  const source = eventStoreSection(options)
    ?? sessionManagerSection(options)
    ?? fallbackSection(reason, options, now);
  const body = [
    `# ${title}`,
    `generated_at: ${now}`,
    `cwd: ${options.cwd}`,
    `wing: ${options.wing}`,
    `session_id: ${options.sessionId}`,
    "",
    source,
  ].join("\n");
  return { body: truncate(body, options.maxChars ?? DEFAULT_MAX_CHARS), now };
}

export function buildCompactionCheckpoint(options: SessionSummaryOptions): CompactionCheckpoint {
  const { body, now } = buildBody("MemPalace compaction checkpoint", "compaction", options);
  return {
    content: body,
    metadata: {
      wing: options.wing,
      room: "compaction-checkpoints",
      added_by: options.defaultAgentName,
      source_file: `omp-session:${options.sessionId}:compaction:${now}`,
    },
  };
}

export function buildShutdownDiary(options: SessionSummaryOptions): ShutdownDiary {
  const { body, now } = buildBody("MemPalace shutdown diary", "shutdown", options);
  return {
    entry: body,
    metadata: {
      agent_name: options.defaultAgentName,
      wing: options.wing,
      topic: "shutdown",
      timestamp: now,
      source_file: `omp-session:${options.sessionId}:shutdown:${now}`,
    },
  };
}
