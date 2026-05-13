import { describe, expect, test } from "bun:test";
import {
  MEMPALACE_ACTIONS,
  REQUIRED_FIELDS,
  mempalaceToolParameters,
  validateMempalaceParams,
} from "../../src/mempalace/schema.js";
import pythonSignatures from "./fixtures/python-signatures.json";
import {
  MEMPALACE_MAX_CONTENT_LENGTH,
  MEMPALACE_MAX_HOPS,
  MEMPALACE_MAX_NAME_LENGTH,
  MEMPALACE_MAX_QUERY_LENGTH,
  MEMPALACE_MAX_RESULTS,
} from "../../src/mempalace/upstream-limits.js";

const EXPECTED_ACTIONS = [
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

describe("mempalace action schema", () => {
  test("includes all MCP-equivalent and native actions", () => {
    expect(MEMPALACE_ACTIONS).toEqual(EXPECTED_ACTIONS);
    expect(mempalaceToolParameters.properties.action.enum).toEqual(EXPECTED_ACTIONS);
    expect(mempalaceToolParameters.required).toEqual(["action"]);
  });

  test("documents timeout values as seconds", () => {
    expect(mempalaceToolParameters.properties.timeout.description).toContain("seconds");
  });

  test("rejects unknown and missing actions", () => {
    expect(validateMempalaceParams({}).valid).toBe(false);
    const result = validateMempalaceParams({ action: "remember_everything" });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("action must be one of the supported MemPalace actions");
  });

  test("validates required read/search fields before Python execution", () => {
    expect(validateMempalaceParams({ action: "search" }).errors).toContain("query is required for action search");
    expect(validateMempalaceParams({ action: "check_duplicate" }).errors).toContain(
      "content is required for action check_duplicate",
    );
    expect(validateMempalaceParams({ action: "get_drawer" }).errors).toContain(
      "drawer_id is required for action get_drawer",
    );
    expect(validateMempalaceParams({ action: "search", query: "prior decision", limit: 3 }).valid).toBe(true);
  });

  test("validates required drawer write fields", () => {
    expect(validateMempalaceParams({ action: "add_drawer" }).errors).toContain(
      "content is required for action add_drawer",
    );
    expect(validateMempalaceParams({ action: "add_drawer" }).errors).toContain(
      "wing is required for action add_drawer",
    );
    expect(validateMempalaceParams({ action: "add_drawer" }).errors).toContain(
      "room is required for action add_drawer",
    );
    expect(validateMempalaceParams({ action: "update_drawer", drawer_id: "d1" }).errors).toContain(
      "content is required for action update_drawer",
    );
    expect(validateMempalaceParams({ action: "delete_drawer" }).errors).toContain(
      "drawer_id is required for action delete_drawer",
    );
    expect(
      validateMempalaceParams({ action: "add_drawer", wing: "project", room: "notes", content: "Remember this" }).valid,
    ).toBe(true);
  });

  test("validates required knowledge graph fields", () => {
    expect(validateMempalaceParams({ action: "kg_query" }).errors).toContain("subject is required for action kg_query");
    expect(validateMempalaceParams({ action: "kg_add", subject: "A", predicate: "uses" }).errors).toContain(
      "object is required for action kg_add",
    );
    expect(validateMempalaceParams({ action: "kg_invalidate", subject: "A" }).errors).toContain(
      "predicate is required for action kg_invalidate",
    );
    expect(validateMempalaceParams({ action: "kg_invalidate", subject: "A", predicate: "uses" }).errors).toContain(
      "object is required for action kg_invalidate",
    );
    expect(validateMempalaceParams({ action: "kg_timeline" }).errors).toContain(
      "subject is required for action kg_timeline",
    );
  });

  test("validates MemPalace 3.3.5 temporal fields as ISO strings", () => {
    expect(validateMempalaceParams({
      action: "kg_add",
      subject: "A",
      predicate: "uses",
      object: "B",
      valid_from: "2026-05-13",
      valid_to: "2026-05-13T12:30:45Z",
    }).valid).toBe(true);
    expect(validateMempalaceParams({
      action: "kg_query",
      subject: "A",
      as_of: "2026-05-13T12:30:45+00:00",
    }).valid).toBe(true);
    expect(validateMempalaceParams({
      action: "kg_invalidate",
      subject: "A",
      predicate: "uses",
      object: "B",
      ended: "2026-05-13",
    }).valid).toBe(true);
    expect(validateMempalaceParams({
      action: "kg_invalidate",
      subject: "A",
      predicate: "uses",
      object: "B",
      ended: true,
    }).errors).toContain("ended must be a string");
    expect(validateMempalaceParams({
      action: "kg_query",
      subject: "A",
      as_of: "13-05-2026",
    }).errors).toContain("as_of must be an ISO temporal string accepted by MemPalace");
    expect(validateMempalaceParams({
      action: "kg_add",
      subject: "A",
      predicate: "uses",
      object: "B",
      valid_from: "2026-02-31",
    }).errors).toContain("valid_from must be an ISO temporal string accepted by MemPalace");
    expect(validateMempalaceParams({
      action: "kg_query",
      subject: "A",
      as_of: "2026-05-13T24:00:00Z",
    }).errors).toContain("as_of must be an ISO temporal string accepted by MemPalace");
  });

  test("trims surrounding whitespace on ISO temporal fields and propagates the trimmed value", () => {
    // Common shape from log lines, env vars, and copy-paste flows: a valid
    // date wrapped in whitespace. Upstream MemPalace stores `valid_*` as raw
    // text into sqlite, so an untrimmed value would never match `>= ?`
    // comparisons in tool_kg_query. Trim here so the persisted value is the
    // strict ISO form.
    const result = validateMempalaceParams({
      action: "kg_add",
      subject: "A",
      predicate: "uses",
      object: "B",
      valid_from: "  2026-05-13  ",
    });
    expect(result.valid).toBe(true);
    expect(result.params?.valid_from).toBe("2026-05-13");
  });

  test("accepts KG provenance fields exposed by MemPalace 3.3.5", () => {
    const result = validateMempalaceParams({
      action: "kg_add",
      subject: "A",
      predicate: "uses",
      object: "B",
      source_file: "knowledge.md",
      source_drawer_id: "drawer-123",
    });

    expect(result.valid).toBe(true);
    expect(result.params?.source_file).toBe("knowledge.md");
    expect(result.params?.source_drawer_id).toBe("drawer-123");
  });

  test("rejects empty-string ISO temporal values (semantically invalid, not equivalent to absent)", () => {
    // Empty string would otherwise be stored as `""` in kg.triples.valid_from
    // — never matches the `valid_to IS NULL OR valid_to >= ?` clause and
    // produces silent index garbage. The absent-key path uses Python `None`
    // (no field sent), which is the correct way to say "open-ended".
    const result = validateMempalaceParams({
      action: "kg_add",
      subject: "A",
      predicate: "uses",
      object: "B",
      valid_from: "",
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("valid_from must be an ISO temporal string accepted by MemPalace");
  });

  test("enforces upstream maxLength bounds before dispatching to python", () => {
    // The JSON schema already declares maxLength, but the runtime validator
    // is the actual gate before bridge.execute. Without these checks,
    // sanitize_query (tool_search) silently truncates overlong queries
    // upstream and sanitize_name/sanitize_content raise opaque ValueErrors
    // from inside python. Catching at the TS boundary gives every overlong
    // field the same shape and avoids a wasted python spawn.
    expect(validateMempalaceParams({
      action: "search",
      query: "x".repeat(MEMPALACE_MAX_QUERY_LENGTH + 1),
    }).errors).toContain(`query exceeds maximum length of ${MEMPALACE_MAX_QUERY_LENGTH} characters`);

    expect(validateMempalaceParams({
      action: "add_drawer",
      wing: "project",
      room: "notes",
      content: "x".repeat(MEMPALACE_MAX_CONTENT_LENGTH + 1),
    }).errors).toContain(`content exceeds maximum length of ${MEMPALACE_MAX_CONTENT_LENGTH} characters`);

    expect(validateMempalaceParams({
      action: "diary_write",
      agent_name: "omp",
      entry: "x".repeat(MEMPALACE_MAX_CONTENT_LENGTH + 1),
    }).errors).toContain(`entry exceeds maximum length of ${MEMPALACE_MAX_CONTENT_LENGTH} characters`);

    expect(validateMempalaceParams({
      action: "add_drawer",
      wing: "w".repeat(MEMPALACE_MAX_NAME_LENGTH + 1),
      room: "notes",
      content: "ok",
    }).errors).toContain(`wing exceeds maximum length of ${MEMPALACE_MAX_NAME_LENGTH} characters`);

    // Values at the limit are accepted (no off-by-one).
    expect(validateMempalaceParams({
      action: "search",
      query: "x".repeat(MEMPALACE_MAX_QUERY_LENGTH),
    }).valid).toBe(true);
  });

  test("enforces upstream numeric maxima before dispatching to python", () => {
    expect(validateMempalaceParams({
      action: "search",
      query: "auth",
      limit: MEMPALACE_MAX_RESULTS + 1,
    }).errors).toContain(`limit exceeds maximum of ${MEMPALACE_MAX_RESULTS}`);

    expect(validateMempalaceParams({
      action: "traverse",
      start_room: "src",
      max_hops: MEMPALACE_MAX_HOPS + 1,
    }).errors).toContain(`max_hops exceeds maximum of ${MEMPALACE_MAX_HOPS}`);

    expect(validateMempalaceParams({
      action: "search",
      query: "auth",
      limit: MEMPALACE_MAX_RESULTS,
    }).valid).toBe(true);
    expect(validateMempalaceParams({
      action: "traverse",
      start_room: "src",
      max_hops: MEMPALACE_MAX_HOPS,
    }).valid).toBe(true);
  });

  test("validates required navigation and tunnel fields", () => {
    expect(validateMempalaceParams({ action: "traverse" }).errors).toContain(
      "start_room is required for action traverse",
    );
    expect(validateMempalaceParams({ action: "find_tunnels" }).valid).toBe(true);
    expect(validateMempalaceParams({ action: "find_tunnels", source_wing: "a", target_wing: "b" }).valid).toBe(true);
    expect(validateMempalaceParams({ action: "create_tunnel", source_wing: "a", source_room: "r" }).errors).toContain(
      "target_wing is required for action create_tunnel",
    );
    expect(validateMempalaceParams({ action: "delete_tunnel" }).errors).toContain(
      "tunnel_id is required for action delete_tunnel",
    );
  });

  test("validates required diary and native action fields", () => {
    expect(validateMempalaceParams({ action: "diary_write" }).errors).toContain(
      "entry is required for action diary_write",
    );
    expect(validateMempalaceParams({ action: "diary_write" }).errors).toContain(
      "agent_name is required for action diary_write",
    );
    expect(validateMempalaceParams({ action: "diary_read" }).errors).toContain(
      "agent_name is required for action diary_read",
    );
    expect(validateMempalaceParams({ action: "init" }).errors).toContain("dir is required for action init");
    expect(validateMempalaceParams({ action: "mine" }).errors).toContain("dir is required for action mine");
    expect(validateMempalaceParams({ action: "split" }).errors).toContain("source_file is required for action split");
    expect(validateMempalaceParams({ action: "repair" }).valid).toBe(true);
    expect(validateMempalaceParams({
      action: "repair",
      mode: "from-sqlite",
      source: "~/palace.sqlite",
      archive_existing: true,
    }).valid).toBe(true);
    expect(validateMempalaceParams({ action: "wake_up", wing: "project" }).valid).toBe(true);
  });

  test("wake_up_and_search has no required params and accepts wake/search optionals", () => {
    // No required params — all optional, mirrors today's hook behavior.
    expect(validateMempalaceParams({ action: "wake_up_and_search" }).valid).toBe(true);
    // Accepts all documented optional params.
    expect(validateMempalaceParams({
      action: "wake_up_and_search",
      wing: "project",
      query: "auth decisions",
      limit: 3,
      timeout: 10,
      palace: "/tmp/palace",
    }).valid).toBe(true);
    // Rejects invalid optional types.
    expect(validateMempalaceParams({ action: "wake_up_and_search", limit: 0 }).errors).toContain(
      "limit must be a positive integer",
    );
    expect(validateMempalaceParams({ action: "wake_up_and_search", timeout: -1 }).errors).toContain(
      "timeout must be a positive integer",
    );
  });

  test("rejects invalid scalar field types and preserves path-like strings", () => {
    expect(validateMempalaceParams({ action: "search", query: "x", limit: 0 }).errors).toContain(
      "limit must be a positive integer",
    );
    expect(validateMempalaceParams({ action: "repair", archive_existing: "yes" }).errors).toContain(
      "archive_existing must be a boolean",
    );
    expect(validateMempalaceParams({ action: "mine", dir: "~/repo/${USER}", include_ignored: false }).valid).toBe(true);
    const result = validateMempalaceParams({ action: "mine", dir: "~/repo/${USER}", include_ignored: false });
    expect(result.params?.dir).toBe("~/repo/${USER}");
  });

  test("mirrors upstream MemPalace parameter limits in the JSON schema", () => {
    const props = mempalaceToolParameters.properties as Record<string, Record<string, unknown>>;

    // Numeric clamps applied by upstream MCP server (tool_search / tool_list_drawers / tool_traverse_graph).
    expect(props.limit.maximum).toBe(MEMPALACE_MAX_RESULTS);
    expect(props.limit.minimum).toBe(1);
    expect(props.max_hops.maximum).toBe(MEMPALACE_MAX_HOPS);
    expect(props.max_hops.minimum).toBe(1);
    expect(props.offset.minimum).toBe(0);

    // Sanitizer-enforced string bounds.
    expect(props.query.maxLength).toBe(MEMPALACE_MAX_QUERY_LENGTH);
    expect(props.content.maxLength).toBe(MEMPALACE_MAX_CONTENT_LENGTH);
    expect(props.entry.maxLength).toBe(MEMPALACE_MAX_CONTENT_LENGTH);

    // MemPalace 3.3.5 validates KG temporal values before dispatch.
    for (const field of ["as_of", "valid_from", "valid_to", "ended"]) {
      expect(props[field]?.type).toBe("string");
      expect(typeof props[field]?.pattern).toBe("string");
      expect(props[field]?.description).toContain("ISO temporal string");
    }
    expect(props.source.type).toBe("string");
    expect(props.source_file.type).toBe("string");
    expect(props.source_drawer_id.type).toBe("string");
    expect(props.archive_existing.type).toBe("boolean");

    // sanitize_name / sanitize_kg_value enforce MAX_NAME_LENGTH on every
    // wing/room/entity-style identifier. Keep this list in sync with the
    // upstream sanitizer call sites in mempalace/mcp_server.py.
    const nameFields = [
      "wing",
      "room",
      "subject",
      "predicate",
      "object",
      "start_room",
      "source_wing",
      "source_room",
      "target_wing",
      "target_room",
      "agent_name",
      "topic",
    ];
    for (const field of nameFields) {
      expect(props[field]?.maxLength).toBe(MEMPALACE_MAX_NAME_LENGTH);
    }
  });
});

describe("schema↔python dispatch drift", () => {
  type Sig = {
    fn: string;
    kind: "select" | "rename" | "lambda";
    params?: string[];
    renames?: Record<string, string>;
    required: string[];
  };
  const sigs = pythonSignatures as Record<string, Sig>;

  test("schema required fields exactly match the python dispatch fixture", () => {
    for (const [action, sig] of Object.entries(sigs)) {
      const schemaRequired = [...((REQUIRED_FIELDS as Record<string, readonly string[]>)[action] ?? [])].sort();
      expect(schemaRequired).toEqual([...sig.required].sort());
    }
  });

  test("every REQUIRED_FIELDS entry is accepted by the python extractor (prevents silent field drop)", () => {
    for (const [action, sig] of Object.entries(sigs)) {
      const schemaRequired = (REQUIRED_FIELDS as Record<string, readonly string[]>)[action] ?? [];
      for (const field of schemaRequired) {
        if (sig.kind === "select") {
          expect((sig.params ?? [])).toContain(field);
        } else if (sig.kind === "rename") {
          expect(Object.keys(sig.renames ?? {})).toContain(field);
        }
        // lambda with non-empty required would be a bug caught by the test above
      }
    }
  });

  test("drift test fails when a required field is removed from the schema (guard for reviewer checklist)", () => {
    // Deliberately check add_drawer: if wing were removed from REQUIRED_FIELDS,
    // the python extractor would silently drop it and tool_add_drawer would TypeError.
    const required = (REQUIRED_FIELDS as Record<string, readonly string[]>)["add_drawer"] ?? [];
    expect(required).toContain("wing");
    expect(required).toContain("room");
    expect(required).toContain("content");
  });
});
