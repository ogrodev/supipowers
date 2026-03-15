// src/context-mode/snapshot-builder.ts
import type { EventStore, TrackedEvent } from "./event-store.js";

const CAPS = {
  tasks: 10,
  decisions: 5,
  files: 20,
  errors: 3,
  git: 5,
};

/** Build a resume snapshot from tracked events for a session */
export function buildResumeSnapshot(eventStore: EventStore, sessionId: string): string {
  const counts = eventStore.getEventCounts(sessionId);
  const hasAnyEvents = Object.values(counts).some((c) => c > 0);
  if (!hasAnyEvents) return "";

  const sections: string[] = ["<session_knowledge>"];

  // Last request
  const prompts = eventStore.getEvents(sessionId, { categories: ["prompt"], limit: 1 });
  if (prompts.length > 0) {
    const data = safeParse(prompts[0].data);
    const prompt = typeof data?.prompt === "string" ? data.prompt.slice(0, 200) : "";
    if (prompt) {
      sections.push(`  <last_request>${prompt}</last_request>`);
    }
  }

  // Pending tasks
  const tasks = eventStore.getEvents(sessionId, { categories: ["task"], limit: CAPS.tasks });
  if (tasks.length > 0) {
    sections.push("  <pending_tasks>");
    for (const t of tasks) {
      const data = safeParse(t.data);
      const content = extractTaskContent(data);
      if (content) sections.push(`    - ${content.slice(0, 100)}`);
    }
    sections.push("  </pending_tasks>");
  }

  // Key decisions
  const decisions = eventStore.getEvents(sessionId, { categories: ["decision"], limit: CAPS.decisions });
  if (decisions.length > 0) {
    sections.push("  <key_decisions>");
    for (const d of decisions) {
      const data = safeParse(d.data);
      const prompt = typeof data?.prompt === "string" ? data.prompt.slice(0, 100) : "";
      if (prompt) sections.push(`    - ${prompt}`);
    }
    sections.push("  </key_decisions>");
  }

  // Files modified (write/edit only, deduplicated)
  const fileEvents = eventStore.getEvents(sessionId, { categories: ["file"], limit: 200 });
  const modifiedPaths = new Set<string>();
  for (const f of fileEvents) {
    const data = safeParse(f.data);
    if (data?.op === "edit" || data?.op === "write") {
      if (typeof data.path === "string") modifiedPaths.add(data.path);
    }
  }
  if (modifiedPaths.size > 0) {
    sections.push("  <files_modified>");
    const paths = [...modifiedPaths].slice(0, CAPS.files);
    for (const p of paths) sections.push(`    - ${p}`);
    sections.push("  </files_modified>");
  }

  // Recent errors
  const errors = eventStore.getEvents(sessionId, { categories: ["error"], limit: CAPS.errors });
  if (errors.length > 0) {
    sections.push("  <recent_errors>");
    for (const e of errors) {
      const data = safeParse(e.data);
      const summary = formatErrorSummary(data);
      if (summary) sections.push(`    - ${summary.slice(0, 150)}`);
    }
    sections.push("  </recent_errors>");
  }

  // Git state
  const gitEvents = eventStore.getEvents(sessionId, { categories: ["git"], limit: CAPS.git });
  if (gitEvents.length > 0) {
    sections.push("  <git_state>");
    for (const g of gitEvents) {
      const data = safeParse(g.data);
      const cmd = typeof data?.command === "string" ? data.command.slice(0, 100) : "";
      if (cmd) sections.push(`    - ${cmd}`);
    }
    sections.push("  </git_state>");
  }

  sections.push("</session_knowledge>");

  // If only the wrapper tags exist (no inner sections), return empty
  if (sections.length <= 2) return "";

  return sections.join("\n");
}

function safeParse(json: string): Record<string, unknown> | null {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function extractTaskContent(data: Record<string, unknown> | null): string | null {
  if (!data?.input) return null;
  const input = data.input as Record<string, unknown>;
  if (Array.isArray(input.ops)) {
    const ops = input.ops as Array<{ content?: string; op?: string }>;
    return ops.map((o) => `${o.op ?? "task"}: ${o.content ?? ""}`).join("; ");
  }
  return JSON.stringify(input).slice(0, 100);
}

function formatErrorSummary(data: Record<string, unknown> | null): string | null {
  if (!data) return null;
  const command = typeof data.command === "string" ? data.command : "";
  const toolName = typeof data.toolName === "string" ? data.toolName : "";
  const exitCode = typeof data.exitCode === "number" ? ` (exit ${data.exitCode})` : "";
  const prefix = command || toolName;
  return prefix ? `${prefix}${exitCode}` : null;
}
