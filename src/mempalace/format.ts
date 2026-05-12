import type { MempalaceAction } from "./schema.js";
import type { MempalaceConfig } from "../types.js";

export interface MempalaceFormattedResult {
  text: string;
  details: unknown;
}

export interface MempalaceBridgeError {
  code: string;
  message: string;
  remediation?: string;
  [key: string]: unknown;
}

type ResultBudgets = MempalaceConfig["budgets"];

type RecordValue = Record<string, unknown>;

const TRUNCATED_SEARCH_GUIDANCE = "\n\nOutput truncated. Use a narrower query/limit or call get_drawer with a result id for full text.";
const TRUNCATED_LIST_GUIDANCE = "\n\nOutput truncated. Re-run with a smaller limit or a more specific wing/room.";

function asRecord(value: unknown): RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as RecordValue : {};
}

function asArray(value: unknown): RecordValue[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function asCountMap(value: unknown): Array<[string, number]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const out: Array<[string, number]> = [];
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const count = typeof raw === "number" && Number.isFinite(raw) ? raw : Number(raw);
    out.push([key, Number.isFinite(count) ? count : 0]);
  }
  out.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return out;
}

function stringValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function truncateText(text: string, maxChars: number, guidance: string): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= guidance.length + 1) {
    return guidance.trim().slice(0, maxChars);
  }
  const headChars = maxChars - guidance.length - 1;
  return `${text.slice(0, headChars).trimEnd()}…${guidance}`;
}

function formatSimilarity(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "n/a";
}

function formatSearch(result: RecordValue, budgets: ResultBudgets): string {
  const results = asArray(result.results ?? result.items);
  const query = stringValue(result.query) || "(unspecified query)";
  const count = typeof result.count === "number" ? result.count : results.length;
  const lines = [`MemPalace search`, `Search results for ${query} (${count})`];

  for (const [index, item] of results.entries()) {
    const id = stringValue(item.id ?? item.drawer_id) || `#${index + 1}`;
    const wing = stringValue(item.wing);
    const room = stringValue(item.room);
    const location = [wing, room].filter(Boolean).join("/") || "unscoped";
    const excerpt = stringValue(item.content ?? item.text ?? item.entry ?? item.summary).replace(/\s+/g, " ").trim();
    lines.push(`${index + 1}. ${id} · ${location} · similarity ${formatSimilarity(item.similarity ?? item.score)}`);
    if (excerpt) lines.push(`   ${excerpt}`);
  }

  return truncateText(lines.join("\n"), budgets.searchResultChars, TRUNCATED_SEARCH_GUIDANCE);
}

function formatDrawerList(result: RecordValue, budgets: ResultBudgets): string {
  const drawers = asArray(result.drawers ?? result.results ?? result.items);
  const lines = [`Drawers (${drawers.length})`];

  for (const drawer of drawers) {
    const id = stringValue(drawer.id ?? drawer.drawer_id) || "unknown";
    const location = [stringValue(drawer.wing), stringValue(drawer.room)].filter(Boolean).join("/") || "unscoped";
    const updated = stringValue(drawer.updated_at ?? drawer.created_at ?? drawer.timestamp);
    lines.push(`- ${id} · ${location}${updated ? ` · ${updated}` : ""}`);
  }

  return truncateText(lines.join("\n"), budgets.listResultChars, TRUNCATED_LIST_GUIDANCE);
}

function formatWingList(result: RecordValue, budgets: ResultBudgets): string {
  const wings = asCountMap(result.wings);
  const total = wings.reduce((acc, [, n]) => acc + n, 0);
  const lines = [`Wings (${wings.length}${total ? `, ${total} drawers`: ""})`];
  for (const [name, count] of wings) {
    lines.push(`- ${name} (${count})`);
  }
  if (result.partial) lines.push("(partial result — palace returned an error mid-scan)");
  return truncateText(lines.join("\n"), budgets.listResultChars, TRUNCATED_LIST_GUIDANCE);
}

function formatRoomList(result: RecordValue, budgets: ResultBudgets): string {
  const wing = stringValue(result.wing) || "all";
  const rooms = asCountMap(result.rooms);
  const total = rooms.reduce((acc, [, n]) => acc + n, 0);
  const lines = [`Rooms in ${wing} (${rooms.length}${total ? `, ${total} drawers` : ""})`];
  for (const [name, count] of rooms) {
    lines.push(`- ${name} (${count})`);
  }
  if (result.partial) lines.push("(partial result — palace returned an error mid-scan)");
  return truncateText(lines.join("\n"), budgets.listResultChars, TRUNCATED_LIST_GUIDANCE);
}

function formatDiary(result: RecordValue, budgets: ResultBudgets): string {
  const entries = asArray(result.entries ?? result.results ?? result.items);
  const lines = [`Diary entries (${entries.length})`];

  for (const entry of entries) {
    const timestamp = stringValue(entry.timestamp ?? entry.created_at);
    const agent = stringValue(entry.agent_name ?? entry.agent) || "unknown-agent";
    const text = stringValue(entry.entry ?? entry.content ?? entry.text).replace(/\s+/g, " ").trim();
    lines.push(`- ${timestamp ? `${timestamp} · ` : ""}${agent}: ${text}`);
  }

  return truncateText(lines.join("\n"), budgets.diaryChars, TRUNCATED_LIST_GUIDANCE);
}

function formatStatus(result: RecordValue): string {
  const lines = ["MemPalace status"];
  const palacePath = stringValue(result.palacePath ?? result.palace_path ?? result.palace);
  if (palacePath) lines.push(`palace: ${palacePath}`);
  if ("ready" in result) lines.push(`ready: ${String(result.ready)}`);
  if ("version" in result) lines.push(`version: ${stringValue(result.version)}`);

  const wingsCount = Array.isArray(result.wings)
    ? result.wings.length
    : result.wings && typeof result.wings === "object"
      ? Object.keys(result.wings as Record<string, unknown>).length
      : (typeof result.wingCount === "number" ? result.wingCount : undefined)
        ?? (typeof result.wings_count === "number" ? result.wings_count : undefined);
  lines.push(`wings: ${wingsCount === undefined ? "unknown" : String(wingsCount)}`);

  if (typeof result.total_drawers === "number") lines.push(`drawers: ${result.total_drawers}`);
  else if (typeof result.totalDrawers === "number") lines.push(`drawers: ${result.totalDrawers}`);

  return lines.join("\n");
}

function formatGeneric(action: MempalaceAction, result: RecordValue, budgets: ResultBudgets): string {
  const summary = stringValue(result.message ?? result.summary ?? result.status);
  if (summary) return truncateText(`MemPalace ${action}: ${summary}`, budgets.listResultChars, TRUNCATED_LIST_GUIDANCE);
  return truncateText(`MemPalace ${action} result\n${JSON.stringify(result, null, 2)}`, budgets.listResultChars, TRUNCATED_LIST_GUIDANCE);
}

export function formatMempalaceResult(
  action: MempalaceAction,
  result: unknown,
  budgets: ResultBudgets,
): MempalaceFormattedResult {
  const record = asRecord(result);
  let text: string;

  if (action === "status" || action === "version") {
    text = formatStatus(record);
  } else if (action === "search" || action === "wake_up") {
    text = formatSearch(record, budgets);
  } else if (action === "list_drawers") {
    text = formatDrawerList(record, budgets);
  } else if (action === "list_wings") {
    text = formatWingList(record, budgets);
  } else if (action === "list_rooms") {
    text = formatRoomList(record, budgets);
  } else if (action === "diary_read") {
    text = formatDiary(record, budgets);
  } else {
    text = formatGeneric(action, record, budgets);
  }

  return { text, details: result };
}

export function formatMempalaceError(error: MempalaceBridgeError, details: Record<string, unknown> = {}): MempalaceFormattedResult {
  const lines = [`MemPalace error (${error.code})`, error.message];
  if (error.remediation) lines.push(`Remediation: ${error.remediation}`);

  // Surface bridge subprocess output. When the bridge fails (e.g. malformed
  // JSON, non-zero exit) the model and the user need to see what actually
  // happened, not just the abstract error code.
  const diagnostics = (details.diagnostics ?? {}) as Record<string, unknown>;
  const stderrTail = pickString(diagnostics.stderrTail) ?? pickString(details.stderrTail);
  const stdoutPreview = pickString(diagnostics.stdoutPreview) ?? pickString(details.stdoutPreview);
  if (stderrTail && stderrTail.trim().length > 0) {
    lines.push("", "Bridge stderr:", stderrTail.trim());
  }
  if (stdoutPreview && stdoutPreview.trim().length > 0) {
    lines.push("", "Bridge stdout (preview):", stdoutPreview.trim());
  }

  return {
    text: lines.join("\n"),
    details: { ...details, error },
  };
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
