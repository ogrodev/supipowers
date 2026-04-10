// src/context-mode/snapshot-builder.ts
import type { EventStore, TrackedEvent } from "./event-store.js";

const CAPS = {
  tasks: 10,
  decisions: 5,
  files: 20,
  errors: 3,
  git: 5,
};

/** Escape all 5 XML special characters in user data */
function escapeXML(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

interface SnapshotOpts {
  compactCount?: number;
  searchTool?: string;
  searchAvailable?: boolean;
}

/** Build a resume snapshot from tracked events for a session */
export function buildResumeSnapshot(
  eventStore: EventStore,
  sessionId: string,
  opts?: SnapshotOpts,
): string {
  const counts = eventStore.getEventCounts(sessionId);
  const hasAnyEvents = Object.values(counts).some((c) => c > 0);
  if (!hasAnyEvents) return "";

  if (opts?.searchAvailable) {
    return buildReferenceSnapshot(eventStore, sessionId, opts);
  }
  return buildFallbackSnapshot(eventStore, sessionId);
}

// ---------------------------------------------------------------------------
// Reference-based format (supi-context-mode MCP available)
// ---------------------------------------------------------------------------

function buildReferenceSnapshot(eventStore: EventStore, sessionId: string, opts: SnapshotOpts): string {
  const compactCount = opts.compactCount ?? 0;
  const now = new Date().toISOString();
  const sections: string[] = [
    `<session_knowledge compact_count="${compactCount}" generated_at="${escapeXML(now)}">`,
    "  <how_to_search>",
    "  Each section below contains a summary of prior work.",
    "  For FULL DETAILS, run the exact tool call shown under each section.",
    "  Do NOT ask the user to re-explain prior work. Search first.",
    "  </how_to_search>",
  ];

  let hasSections = false;

  // --- rules ---
  const ruleEvents = eventStore.getEvents(sessionId, { categories: ["rule"] });
  if (ruleEvents.length > 0) {
    const files = new Set<string>();
    for (const r of ruleEvents) {
      const data = safeParse(r.data);
      const file = typeof data?.file === "string" ? data.file : typeof data?.path === "string" ? data.path : null;
      if (file) files.add(file);
    }
    if (files.size > 0) {
      const fileList = [...files];
      sections.push("");
      sections.push(`  <rules>`);
      sections.push(`    Loaded ${fileList.length} project rule files: ${fileList.map(escapeXML).join(", ")}`);
      sections.push(`    For full details:`);
      sections.push(`    ctx_search(queries: [${fileList.map((f) => `"${escapeXML(f)}"`).join(", ")}], source: "session-events")`);
      sections.push(`  </rules>`);
      hasSections = true;
    }
  }

  // --- files ---
  const fileEvents = eventStore.getEvents(sessionId, { categories: ["file"], limit: 200 });
  if (fileEvents.length > 0) {
    const edited = new Set<string>();
    const read = new Set<string>();
    for (const f of fileEvents) {
      const data = safeParse(f.data);
      const p = typeof data?.path === "string" ? data.path : null;
      if (!p) continue;
      if (data?.op === "edit" || data?.op === "write") edited.add(p);
      else if (data?.op === "read") read.add(p);
    }
    if (edited.size > 0 || read.size > 0) {
      sections.push("");
      sections.push(`  <files count="${edited.size + read.size}">`);
      if (edited.size > 0) sections.push(`    Edited: ${[...edited].map(escapeXML).join(", ")}`);
      if (read.size > 0) sections.push(`    Read: ${[...read].map(escapeXML).join(", ")}`);
      const queryPaths = [...edited, ...read].slice(0, 5);
      sections.push(`    For full details:`);
      sections.push(`    ctx_search(queries: [${queryPaths.map((p) => `"${escapeXML(p)}"`).join(", ")}], source: "session-events")`);
      sections.push(`  </files>`);
      hasSections = true;
    }
  }

  // --- tasks ---
  const tasks = eventStore.getEvents(sessionId, { categories: ["task"], limit: CAPS.tasks });
  if (tasks.length > 0) {
    const summaries: string[] = [];
    for (const t of tasks) {
      const data = safeParse(t.data);
      const content = extractTaskContent(data);
      if (content) summaries.push(escapeXML(content.slice(0, 100)));
    }
    if (summaries.length > 0) {
      sections.push("");
      sections.push(`  <tasks>`);
      for (const s of summaries) sections.push(`    ${s}`);
      sections.push(`    For full details:`);
      sections.push(`    ctx_search(queries: ["task", "todo"], source: "session-events")`);
      sections.push(`  </tasks>`);
      hasSections = true;
    }
  }

  // --- decisions ---
  const decisions = eventStore.getEvents(sessionId, { categories: ["decision"], limit: CAPS.decisions });
  if (decisions.length > 0) {
    const summaries: string[] = [];
    for (const d of decisions) {
      const data = safeParse(d.data);
      const prompt = typeof data?.prompt === "string" ? data.prompt.slice(0, 100) : "";
      if (prompt) summaries.push(escapeXML(prompt));
    }
    if (summaries.length > 0) {
      sections.push("");
      sections.push(`  <decisions>`);
      for (const s of summaries) sections.push(`    ${s}`);
      sections.push(`  </decisions>`);
      hasSections = true;
    }
  }

  // --- errors ---
  const errors = eventStore.getEvents(sessionId, { categories: ["error"], limit: CAPS.errors });
  if (errors.length > 0) {
    const summaries: string[] = [];
    for (const e of errors) {
      const data = safeParse(e.data);
      const summary = formatErrorSummary(data);
      if (summary) summaries.push(escapeXML(summary.slice(0, 150)));
    }
    if (summaries.length > 0) {
      sections.push("");
      sections.push(`  <errors>`);
      for (const s of summaries) sections.push(`    ${s}`);
      sections.push(`  </errors>`);
      hasSections = true;
    }
  }

  // --- git ---
  const gitEvents = eventStore.getEvents(sessionId, { categories: ["git"], limit: CAPS.git });
  if (gitEvents.length > 0) {
    const summaries: string[] = [];
    for (const g of gitEvents) {
      const data = safeParse(g.data);
      const cmd = typeof data?.command === "string" ? data.command.slice(0, 100) : "";
      if (cmd) summaries.push(escapeXML(cmd));
    }
    if (summaries.length > 0) {
      sections.push("");
      sections.push(`  <git>`);
      for (const s of summaries) sections.push(`    ${s}`);
      sections.push(`  </git>`);
      hasSections = true;
    }
  }

  // --- skills ---
  const skillEvents = eventStore.getEvents(sessionId, { categories: ["skill"] });
  if (skillEvents.length > 0) {
    const names = new Set<string>();
    for (const s of skillEvents) {
      const data = safeParse(s.data);
      const name = typeof data?.name === "string" ? data.name : typeof data?.skill === "string" ? data.skill : null;
      if (name) names.add(name);
    }
    if (names.size > 0) {
      sections.push("");
      sections.push(`  <skills>`);
      sections.push(`    Activated: ${[...names].map(escapeXML).join(", ")}`);
      sections.push(`  </skills>`);
      hasSections = true;
    }
  }

  // --- intent ---
  const intentEvents = eventStore.getEvents(sessionId, { categories: ["intent"], limit: 1 });
  if (intentEvents.length > 0) {
    const data = safeParse(intentEvents[0].data);
    const mode = typeof data?.mode === "string" ? data.mode : typeof data?.intent === "string" ? data.intent : null;
    if (mode) {
      sections.push("");
      sections.push(`  <intent>Session mode: ${escapeXML(mode)}</intent>`);
      hasSections = true;
    }
  }

  // --- env ---
  const envEvents = eventStore.getEvents(sessionId, { categories: ["env"] });
  if (envEvents.length > 0) {
    const details: string[] = [];
    for (const e of envEvents) {
      const data = safeParse(e.data);
      const detail = typeof data?.detail === "string" ? data.detail : typeof data?.env === "string" ? data.env : null;
      if (detail) details.push(escapeXML(detail.slice(0, 100)));
    }
    if (details.length > 0) {
      sections.push("");
      sections.push(`  <env>`);
      for (const d of details) sections.push(`    ${d}`);
      sections.push(`  </env>`);
      hasSections = true;
    }
  }

  // --- cwd ---
  const cwdEvents = eventStore.getEvents(sessionId, { categories: ["cwd"], limit: 1 });
  if (cwdEvents.length > 0) {
    const data = safeParse(cwdEvents[0].data);
    const cwd = typeof data?.cwd === "string" ? data.cwd : typeof data?.path === "string" ? data.path : null;
    if (cwd) {
      sections.push("");
      sections.push(`  <cwd>${escapeXML(cwd)}</cwd>`);
      hasSections = true;
    }
  }

  sections.push("</session_knowledge>");

  if (!hasSections) return "";

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Fallback inline-truncated format (no supi-context-mode MCP)
// ---------------------------------------------------------------------------

function buildFallbackSnapshot(eventStore: EventStore, sessionId: string): string {
  const sections: string[] = ["<session_knowledge>"];

  // Last request
  const prompts = eventStore.getEvents(sessionId, { categories: ["prompt"], limit: 1 });
  if (prompts.length > 0) {
    const data = safeParse(prompts[0].data);
    const prompt = typeof data?.prompt === "string" ? escapeXML(data.prompt.slice(0, 200)) : "";
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
      if (content) sections.push(`    - ${escapeXML(content.slice(0, 100))}`);
    }
    sections.push("  </pending_tasks>");
  }

  // Key decisions
  const decisions = eventStore.getEvents(sessionId, { categories: ["decision"], limit: CAPS.decisions });
  if (decisions.length > 0) {
    sections.push("  <key_decisions>");
    for (const d of decisions) {
      const data = safeParse(d.data);
      const prompt = typeof data?.prompt === "string" ? escapeXML(data.prompt.slice(0, 100)) : "";
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
    for (const p of paths) sections.push(`    - ${escapeXML(p)}`);
    sections.push("  </files_modified>");
  }

  // Recent errors
  const errors = eventStore.getEvents(sessionId, { categories: ["error"], limit: CAPS.errors });
  if (errors.length > 0) {
    sections.push("  <recent_errors>");
    for (const e of errors) {
      const data = safeParse(e.data);
      const summary = formatErrorSummary(data);
      if (summary) sections.push(`    - ${escapeXML(summary.slice(0, 150))}`);
    }
    sections.push("  </recent_errors>");
  }

  // Git state
  const gitEvents = eventStore.getEvents(sessionId, { categories: ["git"], limit: CAPS.git });
  if (gitEvents.length > 0) {
    sections.push("  <git_state>");
    for (const g of gitEvents) {
      const data = safeParse(g.data);
      const cmd = typeof data?.command === "string" ? escapeXML(data.command.slice(0, 100)) : "";
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
