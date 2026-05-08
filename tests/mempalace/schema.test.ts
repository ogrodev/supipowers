import { describe, expect, test } from "bun:test";
import {
  MEMPALACE_ACTIONS,
  mempalaceToolParameters,
  validateMempalaceParams,
} from "../../src/mempalace/schema.js";

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
    expect(validateMempalaceParams({ action: "update_drawer", drawer_id: "d1" }).errors).toContain(
      "content is required for action update_drawer",
    );
    expect(validateMempalaceParams({ action: "delete_drawer" }).errors).toContain(
      "drawer_id is required for action delete_drawer",
    );
    expect(validateMempalaceParams({ action: "add_drawer", content: "Remember this", wing: "project" }).valid).toBe(
      true,
    );
  });

  test("validates required knowledge graph fields", () => {
    expect(validateMempalaceParams({ action: "kg_query" }).errors).toContain("subject is required for action kg_query");
    expect(validateMempalaceParams({ action: "kg_add", subject: "A", predicate: "uses" }).errors).toContain(
      "object is required for action kg_add",
    );
    expect(validateMempalaceParams({ action: "kg_invalidate", subject: "A" }).errors).toContain(
      "predicate is required for action kg_invalidate",
    );
    expect(validateMempalaceParams({ action: "kg_timeline" }).errors).toContain(
      "subject is required for action kg_timeline",
    );
  });

  test("validates required navigation and tunnel fields", () => {
    expect(validateMempalaceParams({ action: "traverse" }).errors).toContain(
      "start_room is required for action traverse",
    );
    expect(validateMempalaceParams({ action: "find_tunnels", source_wing: "a" }).errors).toContain(
      "source_room is required for action find_tunnels",
    );
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
    expect(validateMempalaceParams({ action: "init" }).errors).toContain("dir is required for action init");
    expect(validateMempalaceParams({ action: "mine" }).errors).toContain("dir is required for action mine");
    expect(validateMempalaceParams({ action: "split" }).errors).toContain("source_file is required for action split");
    expect(validateMempalaceParams({ action: "repair" }).errors).toContain("dir is required for action repair");
    expect(validateMempalaceParams({ action: "wake_up", wing: "project" }).valid).toBe(true);
  });

  test("rejects invalid scalar field types and preserves path-like strings", () => {
    expect(validateMempalaceParams({ action: "search", query: "x", limit: 0 }).errors).toContain(
      "limit must be a positive integer",
    );
    expect(validateMempalaceParams({ action: "mine", dir: "~/repo/${USER}", include_ignored: false }).valid).toBe(true);
    const result = validateMempalaceParams({ action: "mine", dir: "~/repo/${USER}", include_ignored: false });
    expect(result.params?.dir).toBe("~/repo/${USER}");
  });
});
