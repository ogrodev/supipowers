import {
  MEMPALACE_MAX_CONTENT_LENGTH,
  MEMPALACE_MAX_HOPS,
  MEMPALACE_MAX_NAME_LENGTH,
  MEMPALACE_MAX_QUERY_LENGTH,
  MEMPALACE_MAX_RESULTS,
} from "./upstream-limits.js";

export const MEMPALACE_ACTIONS = [
  "status",
  "list_wings",
  "list_rooms",
  "get_taxonomy",
  "search",
  "check_duplicate",
  "get_aaak_spec",
  "get_drawer",
  "list_drawers",
  "add_drawer",
  "update_drawer",
  "delete_drawer",
  "kg_query",
  "kg_add",
  "kg_invalidate",
  "kg_timeline",
  "kg_stats",
  "traverse",
  "find_tunnels",
  "graph_stats",
  "create_tunnel",
  "list_tunnels",
  "delete_tunnel",
  "follow_tunnels",
  "diary_write",
  "diary_read",
  "hook_settings",
  "memories_filed_away",
  "reconnect",
  "setup",
  "version",
  "init",
  "mine",
  "split",
  "repair",
  "wake_up",
  "wake_up_and_search",
] as const;

export type MempalaceAction = typeof MEMPALACE_ACTIONS[number];

export interface MempalaceParams {
  action: MempalaceAction;
  palace?: string;
  wing?: string;
  room?: string;
  query?: string;
  limit?: number;
  offset?: number;
  drawer_id?: string;
  content?: string;
  source_file?: string;
  source_drawer_id?: string;
  added_by?: string;
  subject?: string;
  predicate?: string;
  object?: string;
  valid_from?: string;
  valid_to?: string;
  ended?: string;
  as_of?: string;
  direction?: string;
  start_room?: string;
  max_hops?: number;
  source_wing?: string;
  source_room?: string;
  target_wing?: string;
  target_room?: string;
  label?: string;
  tunnel_id?: string;
  agent_name?: string;
  entry?: string;
  topic?: string;
  dir?: string;
  mode?: string;
  source?: string;
  extract?: boolean;
  dry_run?: boolean;
  archive_existing?: boolean;
  include_ignored?: boolean;
  no_gitignore?: boolean;
  yes?: boolean;
  timeout?: number;
}

export interface MempalaceValidationResult {
  valid: boolean;
  errors: string[];
  params?: MempalaceParams;
}

const STRING_FIELDS = [
  "palace",
  "wing",
  "room",
  "query",
  "drawer_id",
  "content",
  "source_file",
  "source_drawer_id",
  "added_by",
  "subject",
  "predicate",
  "object",
  "valid_from",
  "valid_to",
  "ended",
  "as_of",
  "direction",
  "start_room",
  "source_wing",
  "source_room",
  "target_wing",
  "target_room",
  "label",
  "tunnel_id",
  "agent_name",
  "entry",
  "topic",
  "dir",
  "mode",
  "source",
] as const;

const POSITIVE_INTEGER_FIELDS = ["limit", "max_hops", "timeout"] as const;
const MAX_INTEGER_FIELDS: ReadonlyArray<readonly [keyof MempalaceParams, number]> = [
  ["limit", MEMPALACE_MAX_RESULTS],
  ["max_hops", MEMPALACE_MAX_HOPS],
];
const NON_NEGATIVE_INTEGER_FIELDS = ["offset"] as const;
const BOOLEAN_FIELDS = ["extract", "dry_run", "archive_existing", "include_ignored", "no_gitignore", "yes"] as const;

// Per-field maximum string lengths. Each entry mirrors the JSON schema
// `maxLength` and corresponds to an upstream MemPalace sanitizer bound:
//   - sanitize_query (tool_search) silently truncates anything beyond
//     MAX_QUERY_LENGTH, so callers can't tell their long query was clipped.
//   - sanitize_name / sanitize_kg_value / sanitize_content all raise
//     ValueError beyond their limits, which surfaces as a domain error
//     from the python bridge instead of at the TS boundary.
// Enforcing here gives every overlong field the same `field exceeds <N>
// characters` error path before the python child is spawned.
const MAX_LENGTH_FIELDS: ReadonlyArray<readonly [keyof MempalaceParams, number]> = [
  ["query", MEMPALACE_MAX_QUERY_LENGTH],
  ["content", MEMPALACE_MAX_CONTENT_LENGTH],
  ["entry", MEMPALACE_MAX_CONTENT_LENGTH],
  ["wing", MEMPALACE_MAX_NAME_LENGTH],
  ["room", MEMPALACE_MAX_NAME_LENGTH],
  ["subject", MEMPALACE_MAX_NAME_LENGTH],
  ["predicate", MEMPALACE_MAX_NAME_LENGTH],
  ["object", MEMPALACE_MAX_NAME_LENGTH],
  ["start_room", MEMPALACE_MAX_NAME_LENGTH],
  ["source_wing", MEMPALACE_MAX_NAME_LENGTH],
  ["source_room", MEMPALACE_MAX_NAME_LENGTH],
  ["target_wing", MEMPALACE_MAX_NAME_LENGTH],
  ["target_room", MEMPALACE_MAX_NAME_LENGTH],
  ["agent_name", MEMPALACE_MAX_NAME_LENGTH],
  ["topic", MEMPALACE_MAX_NAME_LENGTH],
] as const;

export const REQUIRED_FIELDS: Partial<Record<MempalaceAction, readonly (keyof MempalaceParams)[]>> = {
  search: ["query"],
  check_duplicate: ["content"],
  get_drawer: ["drawer_id"],
  list_drawers: ["wing"],
  add_drawer: ["wing", "room", "content"],
  update_drawer: ["drawer_id", "content"],
  delete_drawer: ["drawer_id"],
  kg_query: ["subject"],
  kg_add: ["subject", "predicate", "object"],
  kg_invalidate: ["subject", "predicate", "object"],
  kg_timeline: ["subject"],
  traverse: ["start_room"],
  create_tunnel: ["source_wing", "source_room", "target_wing", "target_room", "label"],
  delete_tunnel: ["tunnel_id"],
  follow_tunnels: ["source_wing", "source_room"],
  diary_write: ["entry", "agent_name"],
  diary_read: ["agent_name"],
  init: ["dir"],
  mine: ["dir"],
  split: ["source_file"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isMempalaceAction(action: unknown): action is MempalaceAction {
  return typeof action === "string" && (MEMPALACE_ACTIONS as readonly string[]).includes(action);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

const ISO_DATE_PART_PATTERN = "\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])";
const ISO_UTC_DATETIME_PATTERN = `${ISO_DATE_PART_PATTERN}T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:Z|\\+00:00)`;
const ISO_TEMPORAL_PATTERN = `^(?:${ISO_DATE_PART_PATTERN}|${ISO_UTC_DATETIME_PATTERN})$`;
const ISO_TEMPORAL_DESCRIPTION =
  "ISO temporal string accepted by MemPalace: YYYY-MM-DD, YYYY-MM-DDTHH:MM:SSZ, or YYYY-MM-DDTHH:MM:SS+00:00.";
const ISO_TEMPORAL_SCHEMA = {
  type: "string",
  pattern: ISO_TEMPORAL_PATTERN,
  description: ISO_TEMPORAL_DESCRIPTION,
} as const;
const ISO_TEMPORAL_REGEX = new RegExp(ISO_TEMPORAL_PATTERN);
const ISO_TEMPORAL_FIELDS = ["as_of", "valid_from", "valid_to", "ended"] as const;
const DAYS_IN_MONTH = [31, 0, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function fixedInt(value: string, start: number, end: number): number {
  let out = 0;
  for (let i = start; i < end; i += 1) {
    out = out * 10 + value.charCodeAt(i) - 48;
  }
  return out;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isValidIsoTemporal(value: string): boolean {
  if (!ISO_TEMPORAL_REGEX.test(value)) return false;

  const year = fixedInt(value, 0, 4);
  const month = fixedInt(value, 5, 7);
  const day = fixedInt(value, 8, 10);
  if (year < 1) return false;

  const daysInMonth = month === 2 ? (isLeapYear(year) ? 29 : 28) : DAYS_IN_MONTH[month - 1];
  return day <= daysInMonth;
}

export const mempalaceToolParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: MEMPALACE_ACTIONS,
      description: "Action to dispatch.",
    },
    palace: { type: "string" },
    wing: {
      type: "string",
      maxLength: MEMPALACE_MAX_NAME_LENGTH,
      description: "Wing name. Required for list_drawers to scope the query and avoid an accidental full-palace dump.",
    },
    room: { type: "string", maxLength: MEMPALACE_MAX_NAME_LENGTH },
    query: { type: "string", maxLength: MEMPALACE_MAX_QUERY_LENGTH },
    limit: { type: "integer", minimum: 1, maximum: MEMPALACE_MAX_RESULTS },
    offset: { type: "integer", minimum: 0, description: "Zero-based pagination offset (use with limit for list_drawers and similar listing actions)." },
    drawer_id: { type: "string" },
    content: { type: "string", maxLength: MEMPALACE_MAX_CONTENT_LENGTH },
    source_file: { type: "string" },
    source_drawer_id: { type: "string" },
    added_by: { type: "string" },
    subject: { type: "string", maxLength: MEMPALACE_MAX_NAME_LENGTH },
    predicate: { type: "string", maxLength: MEMPALACE_MAX_NAME_LENGTH },
    object: { type: "string", maxLength: MEMPALACE_MAX_NAME_LENGTH },
    valid_from: ISO_TEMPORAL_SCHEMA,
    valid_to: ISO_TEMPORAL_SCHEMA,
    ended: ISO_TEMPORAL_SCHEMA,
    as_of: ISO_TEMPORAL_SCHEMA,
    direction: { type: "string" },
    start_room: { type: "string", maxLength: MEMPALACE_MAX_NAME_LENGTH },
    max_hops: { type: "integer", minimum: 1, maximum: MEMPALACE_MAX_HOPS },
    source_wing: { type: "string", maxLength: MEMPALACE_MAX_NAME_LENGTH },
    source_room: { type: "string", maxLength: MEMPALACE_MAX_NAME_LENGTH },
    target_wing: { type: "string", maxLength: MEMPALACE_MAX_NAME_LENGTH },
    target_room: { type: "string", maxLength: MEMPALACE_MAX_NAME_LENGTH },
    label: { type: "string" },
    tunnel_id: { type: "string" },
    agent_name: { type: "string", maxLength: MEMPALACE_MAX_NAME_LENGTH },
    entry: { type: "string", maxLength: MEMPALACE_MAX_CONTENT_LENGTH },
    topic: { type: "string", maxLength: MEMPALACE_MAX_NAME_LENGTH },
    dir: { type: "string" },
    mode: { type: "string" },
    source: { type: "string" },
    extract: { type: "boolean" },
    dry_run: { type: "boolean" },
    archive_existing: { type: "boolean" },
    include_ignored: { type: "boolean" },
    no_gitignore: { type: "boolean" },
    yes: { type: "boolean" },
    timeout: {
      type: "integer",
      minimum: 1,
      description: "Optional bridge timeout in seconds; capped by the configured MemPalace bridge timeout.",
    },
  },
  required: ["action"],
} as const;

export function validateMempalaceParams(params: unknown): MempalaceValidationResult {
  if (!isRecord(params)) {
    return { valid: false, errors: ["params must be an object"] };
  }

  const errors: string[] = [];
  const action = params.action;
  if (!isMempalaceAction(action)) {
    errors.push(
      action === undefined
        ? "action is required"
        : "action must be one of the supported MemPalace actions",
    );
    return { valid: false, errors };
  }

  for (const field of STRING_FIELDS) {
    const value = params[field];
    if (value !== undefined && typeof value !== "string") {
      errors.push(`${field} must be a string`);
    }
  }

  for (const field of BOOLEAN_FIELDS) {
    const value = params[field];
    if (value !== undefined && typeof value !== "boolean") {
      errors.push(`${field} must be a boolean`);
    }
  }

  for (const field of POSITIVE_INTEGER_FIELDS) {
    const value = params[field];
    if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < 1)) {
      errors.push(`${field} must be a positive integer`);
    }
  }

  for (const field of NON_NEGATIVE_INTEGER_FIELDS) {
    const value = params[field];
    if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < 0)) {
      errors.push(`${field} must be a non-negative integer`);
    }
  }

  for (const [field, max] of MAX_INTEGER_FIELDS) {
    const value = params[field];
    if (typeof value === "number" && Number.isInteger(value) && value > max) {
      errors.push(`${field} exceeds maximum of ${max}`);
    }
  }

  for (const [field, max] of MAX_LENGTH_FIELDS) {
    const value = params[field];
    if (typeof value === "string" && value.length > max) {
      errors.push(`${field} exceeds maximum length of ${max} characters`);
    }
  }

  // ISO temporal fields: callers commonly pass `" 2026-05-13 "` from logs or
  // env vars — strip surrounding whitespace before validating so we accept
  // the same shape MemPalace's downstream sqlite comparison would. Empty
  // strings are still rejected (semantically not a date, and would be stored
  // as garbage in the kg.triples valid_from/valid_to columns).
  for (const field of ISO_TEMPORAL_FIELDS) {
    const value = params[field];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed !== value) {
      (params as Record<string, unknown>)[field] = trimmed;
    }
    if (!isValidIsoTemporal(trimmed)) {
      errors.push(`${field} must be an ISO temporal string accepted by MemPalace`);
    }
  }

  for (const field of REQUIRED_FIELDS[action] ?? []) {
    if (!isNonEmptyString(params[field])) {
      errors.push(`${field} is required for action ${action}`);
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, errors: [], params: params as unknown as MempalaceParams };
}
