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
  added_by?: string;
  subject?: string;
  predicate?: string;
  object?: string;
  valid_from?: string;
  valid_to?: string;
  ended?: boolean;
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
  extract?: boolean;
  dry_run?: boolean;
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
  "added_by",
  "subject",
  "predicate",
  "object",
  "valid_from",
  "valid_to",
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
] as const;

const POSITIVE_INTEGER_FIELDS = ["limit", "max_hops", "timeout"] as const;
const NON_NEGATIVE_INTEGER_FIELDS = ["offset"] as const;
const BOOLEAN_FIELDS = ["ended", "extract", "dry_run", "include_ignored", "no_gitignore", "yes"] as const;

const REQUIRED_FIELDS: Partial<Record<MempalaceAction, readonly (keyof MempalaceParams)[]>> = {
  search: ["query"],
  check_duplicate: ["content"],
  get_drawer: ["drawer_id"],
  list_drawers: ["wing"],
  add_drawer: ["content"],
  update_drawer: ["drawer_id", "content"],
  delete_drawer: ["drawer_id"],
  kg_query: ["subject"],
  kg_add: ["subject", "predicate", "object"],
  kg_invalidate: ["subject", "predicate"],
  kg_timeline: ["subject"],
  traverse: ["start_room"],
  find_tunnels: ["source_wing", "source_room"],
  create_tunnel: ["source_wing", "source_room", "target_wing", "target_room", "label"],
  delete_tunnel: ["tunnel_id"],
  follow_tunnels: ["source_wing", "source_room"],
  diary_write: ["entry"],
  init: ["dir"],
  mine: ["dir"],
  split: ["source_file"],
  repair: ["dir"],
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
    wing: { type: "string" },
    room: { type: "string" },
    query: { type: "string" },
    limit: { type: "integer", minimum: 1 },
    offset: { type: "integer", minimum: 0 },
    drawer_id: { type: "string" },
    content: { type: "string" },
    source_file: { type: "string" },
    added_by: { type: "string" },
    subject: { type: "string" },
    predicate: { type: "string" },
    object: { type: "string" },
    valid_from: { type: "string" },
    valid_to: { type: "string" },
    ended: { type: "boolean" },
    as_of: { type: "string" },
    direction: { type: "string" },
    start_room: { type: "string" },
    max_hops: { type: "integer", minimum: 1 },
    source_wing: { type: "string" },
    source_room: { type: "string" },
    target_wing: { type: "string" },
    target_room: { type: "string" },
    label: { type: "string" },
    tunnel_id: { type: "string" },
    agent_name: { type: "string" },
    entry: { type: "string" },
    topic: { type: "string" },
    dir: { type: "string" },
    mode: { type: "string" },
    extract: { type: "boolean" },
    dry_run: { type: "boolean" },
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
