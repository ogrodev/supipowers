import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { formatMempalaceError, formatMempalaceResult } from "../../src/mempalace/format.js";

const budgets = DEFAULT_CONFIG.mempalace.budgets;

describe("mempalace result formatting", () => {
  test("formats status results with stable diagnostics", () => {
    const formatted = formatMempalaceResult("status", {
      palacePath: "/tmp/palace",
      ready: true,
      wings: ["supipowers", "omp"],
      version: "3.3.4",
    }, budgets);

    expect(formatted.text).toContain("MemPalace status");
    expect(formatted.text).toContain("palace: /tmp/palace");
    expect(formatted.text).toContain("wings: 2");
    expect(formatted.details).toMatchObject({ ready: true, version: "3.3.4" });
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
});
