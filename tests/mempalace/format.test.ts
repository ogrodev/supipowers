import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { formatMempalaceError, formatMempalaceResult } from "../../src/mempalace/format.js";
import { MEMPALACE_PACKAGE_VERSION } from "../../src/mempalace/upstream-limits.js";

const budgets = DEFAULT_CONFIG.mempalace.budgets;

describe("mempalace result formatting", () => {
  test("formats status results with stable diagnostics", () => {
    const formatted = formatMempalaceResult("status", {
      palace_path: "/tmp/palace",
      ready: true,
      // tool_status returns wings/rooms as dicts of counts, not arrays.
      wings: { supipowers: 12, omp: 4 },
      rooms: { src: 5, docs: 2 },
      total_drawers: 16,
      version: MEMPALACE_PACKAGE_VERSION,
    }, budgets);

    expect(formatted.text).toContain("MemPalace status");
    expect(formatted.text).toContain("palace: /tmp/palace");
    expect(formatted.text).toContain("wings: 2");
    expect(formatted.text).toContain("drawers: 16");
    expect(formatted.details).toMatchObject({ ready: true, version: MEMPALACE_PACKAGE_VERSION });
  });

  test("formats list_wings with per-wing counts and totals", () => {
    const formatted = formatMempalaceResult("list_wings", {
      wings: { supipowers: 259, sij_mono: 9377, safelys: 216 },
    }, budgets);

    expect(formatted.text.startsWith("Wings (3, 9852 drawers)")).toBe(true);
    // Sorted by count desc, then name asc.
    const lines = formatted.text.split("\n");
    expect(lines[1]).toBe("- sij_mono (9377)");
    expect(lines[2]).toBe("- supipowers (259)");
    expect(lines[3]).toBe("- safelys (216)");
  });

  test("formats list_rooms scoped to a wing", () => {
    const formatted = formatMempalaceResult("list_rooms", {
      wing: "sij_mono",
      rooms: { apps: 8934, documentation: 264, general: 113 },
    }, budgets);

    expect(formatted.text.startsWith("Rooms in sij_mono (3, 9311 drawers)")).toBe(true);
    expect(formatted.text).toContain("- apps (8934)");
    expect(formatted.text).toContain("- documentation (264)");
  });

  test("formats list_rooms when wing is unspecified", () => {
    const formatted = formatMempalaceResult("list_rooms", {
      wing: "all",
      rooms: {},
    }, budgets);

    expect(formatted.text).toBe("Rooms in all (0)");
  });

  test("formats search results with ids, similarity, and bounded text", () => {
    const formatted = formatMempalaceResult("search", {
      query: "auth",
      count: 2,
      results: [
        { id: "d1", wing: "supipowers", room: "auth", similarity: 0.91, content: "OAuth decision" },
        { id: "d2", wing: "supipowers", room: "release", similarity: 0.72, text: "Release note" },
      ],
    }, { ...budgets, searchResultChars: 220 });

    expect(formatted.text).toContain("Search results for auth");
    expect(formatted.text).toContain("d1");
    expect(formatted.text).toContain("0.91");
    expect(formatted.text).toContain("OAuth decision");
    expect(formatted.details).toMatchObject({ count: 2 });
    expect((formatted.details as any).results[0]).toMatchObject({ id: "d1", similarity: 0.91 });
  });

  test("surfaces search index recovery signals", () => {
    const formatted = formatMempalaceResult("search", {
      query: "auth",
      index_recovered: true,
      results: [{ id: "d1", wing: "supipowers", room: "auth", similarity: 0.91, content: "OAuth decision" }],
    }, budgets);

    expect(formatted.text).toContain("Index recovered");
    expect(formatted.details).toMatchObject({ index_recovered: true });
  });

  test("keeps search index recovery visible when results are truncated", () => {
    const formatted = formatMempalaceResult("search", {
      query: "auth",
      index_recovered: true,
      results: [
        { id: "d1", wing: "supipowers", room: "auth", similarity: 0.91, content: "x".repeat(1000) },
      ],
    }, { ...budgets, searchResultChars: 180 });

    expect(formatted.text).toContain("Index recovered");
    expect(formatted.text).toContain("Output truncated");
  });

  test("formats drawer lists deterministically", () => {
    const formatted = formatMempalaceResult("list_drawers", {
      drawers: [
        { id: "a", wing: "w", room: "r", updated_at: "2026-01-02" },
        { id: "b", wing: "w", room: "r2", updated_at: "2026-01-03" },
      ],
    }, budgets);

    expect(formatted.text).toContain("Drawers (2)");
    expect(formatted.text.indexOf("a")).toBeLessThan(formatted.text.indexOf("b"));
    expect(formatted.details).toMatchObject({ drawers: [{ id: "a" }, { id: "b" }] });
  });

  test("formats drawer list totals when upstream returns pagination metadata", () => {
    const formatted = formatMempalaceResult("list_drawers", {
      total: 57,
      drawers: [
        { id: "a", wing: "w", room: "r", updated_at: "2026-01-02" },
        { id: "b", wing: "w", room: "r2", updated_at: "2026-01-03" },
      ],
    }, budgets);

    expect(formatted.text).toContain("Drawers (2 shown, 57 total)");
    expect(formatted.details).toMatchObject({ total: 57 });
  });

  test("formats diary reads", () => {
    const formatted = formatMempalaceResult("diary_read", {
      entries: [
        { timestamp: "2026-05-04T00:00:00.000Z", agent_name: "omp", entry: "Shipped checkpoint" },
      ],
    }, budgets);

    expect(formatted.text).toContain("Diary entries (1)");
    expect(formatted.text).toContain("omp");
    expect(formatted.text).toContain("Shipped checkpoint");
  });

  test("formats errors with remediation", () => {
    const formatted = formatMempalaceError({
      code: "mempalace_missing",
      message: "MemPalace is not installed.",
      remediation: "Call mempalace(action=\"setup\") first.",
    }, { action: "search", wing: "supipowers" });

    expect(formatted.text).toContain("mempalace_missing");
    expect(formatted.text).toContain("MemPalace is not installed.");
    expect(formatted.text).toContain("Call mempalace(action=\"setup\") first.");
    expect(formatted.details).toMatchObject({ action: "search", wing: "supipowers", error: { code: "mempalace_missing" } });
  });

  test("truncates visible output under configured budgets with follow-up guidance", () => {
    const formatted = formatMempalaceResult("search", {
      query: "large",
      results: [{ id: "huge", similarity: 0.5, content: "x".repeat(500) }],
    }, { ...budgets, searchResultChars: 180 });

    expect(formatted.text.length).toBeLessThanOrEqual(180);
    expect(formatted.text).toContain("Output truncated");
    expect(formatted.text).toContain("get_drawer");
    expect((formatted.details as any).results[0].id).toBe("huge");
  });

  test("formatSearch surfaces filter context when filters are present", () => {
    const formatted = formatMempalaceResult("search", {
      query: "auth",
      count: 1,
      results: [{ id: "d1", wing: "foo", room: "bar", similarity: 0.8, content: "decision" }],
      filters: { wing: "foo", room: "bar" },
    }, budgets);

    expect(formatted.text).toContain("Filters applied: wing=foo, room=bar");
  });

  test("formatSearch surfaces filtered-out count when total_before_filter exceeds count", () => {
    const formatted = formatMempalaceResult("search", {
      query: "auth",
      count: 1,
      total_before_filter: 8,
      results: [{ id: "d1", wing: "foo", room: "bar", similarity: 0.8, content: "decision" }],
    }, budgets);

    expect(formatted.text).toContain("Filtered out 7 hit(s) by wing/room scope.");
  });

  test("formatSearch omits filter lines when no filters or total_before_filter present", () => {
    const formatted = formatMempalaceResult("search", {
      query: "auth",
      count: 1,
      results: [{ id: "d1", wing: "foo", room: "bar", similarity: 0.8, content: "decision" }],
    }, budgets);

    expect(formatted.text).not.toContain("Filters applied");
    expect(formatted.text).not.toContain("Filtered out");
  });

  test("formatSearch omits filter lines when total_before_filter equals count", () => {
    const formatted = formatMempalaceResult("search", {
      query: "auth",
      count: 2,
      total_before_filter: 2,
      results: [
        { id: "d1", wing: "foo", room: "bar", similarity: 0.8, content: "a" },
        { id: "d2", wing: "foo", room: "bar", similarity: 0.7, content: "b" },
      ],
    }, budgets);

    expect(formatted.text).not.toContain("Filtered out");
  });

  describe("formatWakeUpAndSearch", () => {
    test("full payload: renders wake text then search block separated by blank line", () => {
      const formatted = formatMempalaceResult("wake_up_and_search", {
        wake: { text: "L0+L1 memory content for the session" },
        search: {
          query: "auth decisions",
          count: 1,
          results: [{ id: "d1", wing: "project", room: "auth", similarity: 0.91, content: "JWT bearer" }],
        },
      }, budgets);

      // Wake block carries the L0/L1 text the model is supposed to actually
      // read — previously this was silently dropped because the formatter
      // routed wake through formatSearch, which only reads query/results.
      expect(formatted.text).toContain("MemPalace wake");
      expect(formatted.text).toContain("L0+L1 memory content for the session");
      expect(formatted.text).toContain("MemPalace search");
      expect(formatted.text).toContain("Search results for auth decisions");
      expect(formatted.text).toContain("JWT bearer");
      // Two sections separated by blank line.
      expect(formatted.text).toContain("\n\n");
      expect(formatted.details).toMatchObject({ wake: { text: "L0+L1 memory content for the session" } });
    });

    test("search-null payload: renders wake block only, no search section", () => {
      const formatted = formatMempalaceResult("wake_up_and_search", {
        wake: { text: "L0+L1 memory content" },
        search: null,
      }, budgets);

      expect(formatted.text).toContain("MemPalace wake");
      expect(formatted.text).toContain("L0+L1 memory content");
      expect(formatted.text).not.toContain("MemPalace search");
      // Only one section — no double newline separator from a second section.
      expect(formatted.text).not.toContain("\n\n");
    });

    test("search-error payload: renders wake block plus one-line search error notice", () => {
      const formatted = formatMempalaceResult("wake_up_and_search", {
        wake: { text: "L0+L1 memory content" },
        search: null,
        search_error: "mempalace_runtime_error: tool_search raised: index missing",
      }, budgets);

      expect(formatted.text).toContain("MemPalace wake");
      expect(formatted.text).toContain("L0+L1 memory content");
      expect(formatted.text).toContain("MemPalace search:");
      expect(formatted.text).toContain("mempalace_runtime_error");
      // Caller can tell "search failed" from "no query → no hits" (the latter
      // omits the search line entirely).
    });

    test("applies one final budget cap after joining wake and search sections", () => {
      const formatted = formatMempalaceResult("wake_up_and_search", {
        wake: { text: "wake ".repeat(100) },
        search: {
          query: "auth",
          count: 1,
          results: [{ id: "d1", wing: "project", room: "auth", similarity: 0.91, content: "search ".repeat(100) }],
        },
      }, { ...budgets, searchResultChars: 180 });

      expect(formatted.text.length).toBeLessThanOrEqual(180);
      expect(formatted.text).toContain("Output truncated");
    });

    test("wake-null payload: emits one-line notice and still shows search hits", () => {
      const formatted = formatMempalaceResult("wake_up_and_search", {
        wake: null,
        wake_error: "mempalace_runtime_error: MemoryStack.wake_up raised: connection refused",
        search: {
          query: "auth",
          count: 1,
          results: [{ id: "d2", wing: "project", room: "auth", similarity: 0.85, content: "OAuth flow" }],
        },
      }, budgets);

      expect(formatted.text).toContain("MemPalace wake:");
      expect(formatted.text).toContain("mempalace_runtime_error");
      expect(formatted.text).toContain("Search results for auth");
      expect(formatted.text).toContain("OAuth flow");
    });

    test("wake-null with no wake_error falls back to generic notice", () => {
      const formatted = formatMempalaceResult("wake_up_and_search", {
        wake: null,
        search: null,
      }, budgets);

      expect(formatted.text).toBe("MemPalace wake: wake_up failed");
    });
  });
});