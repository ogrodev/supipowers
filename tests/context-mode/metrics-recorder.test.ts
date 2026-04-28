// tests/context-mode/metrics-recorder.test.ts
import { describe, expect, test } from "bun:test";
import { toMetricRow } from "../../src/context-mode/metrics-recorder.js";

function eventFor(
  toolName: string,
  input: Record<string, unknown>,
  text: string,
): { toolName: string; input: Record<string, unknown>; content: any[] } {
  return {
    toolName,
    input,
    content: [{ type: "text" as const, text }],
  };
}

describe("toMetricRow — read with full file (Task 17)", () => {
  test("populates layer L2, processor read, and a non-null source hash", () => {
    const row = toMetricRow({
      event: eventFor("read", { path: "/abs/foo.ts" }, "x".repeat(8 * 1024)),
      compressed: { content: [{ type: "text", text: "y".repeat(2 * 1024) }] },
      sessionId: "s1",
      cwd: "/abs",
      projectSlug: "demo",
      contextUsage: null,
      ts: 1700,
    });

    expect(row.tool).toBe("read");
    expect(row.processor).toBe("read");
    expect(row.layer).toBe("L2");
    expect(row.before_bytes).toBe(8 * 1024);
    expect(row.after_bytes).toBe(2 * 1024);
    expect(row.cache_hit).toBe(0);
    expect(row.unique_source_hash).not.toBeNull();
    expect(row.session_id).toBe("s1");
    expect(row.ts).toBe(1700);
  });

  test("does not copy event.input or any literal command text into the row (Task 17 secret-leak guarantee)", () => {
    const command = 'bash -lc "git status; echo $SECRET"';
    const row = toMetricRow({
      event: eventFor("bash", { command }, "ok"),
      compressed: undefined,
      sessionId: "s1",
      cwd: "/repo",
      projectSlug: "demo",
      contextUsage: null,
      ts: 1700,
    });

    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain("$SECRET");
    expect(serialized).not.toContain("echo");
    expect(serialized).not.toContain("git status; echo");
    // The row must not contain the literal command anywhere.
    expect(serialized).not.toContain(command);
  });

  test("propagates contextUsage into the nullable token columns", () => {
    const row = toMetricRow({
      event: eventFor("read", { path: "/abs/foo.ts" }, "x"),
      compressed: undefined,
      sessionId: "s1",
      cwd: "/abs",
      projectSlug: "demo",
      contextUsage: { tokens: 1234, contextWindow: 200_000, percent: 0.0617 },
      ts: 1700,
    });

    expect(row.context_tokens).toBe(1234);
    expect(row.context_window).toBe(200_000);
    expect(row.context_percent).toBeCloseTo(0.0617, 4);
  });

  test("missing contextUsage produces null token columns", () => {
    const row = toMetricRow({
      event: eventFor("read", { path: "/abs/foo.ts" }, "x"),
      compressed: undefined,
      sessionId: "s1",
      cwd: "/abs",
      projectSlug: "demo",
      contextUsage: null,
      ts: 1700,
    });

    expect(row.context_tokens).toBeNull();
    expect(row.context_window).toBeNull();
    expect(row.context_percent).toBeNull();
  });
});

describe("toMetricRow — passthrough vs OMP minimizer (Task 18 + Task 56)", () => {
  test("scoped read with offset/limit and no compression marks passthrough with equal bytes", () => {
    const text = "x".repeat(2048);
    const row = toMetricRow({
      event: eventFor("read", { path: "/abs/foo.ts", offset: 100, limit: 50 }, text),
      compressed: undefined,
      sessionId: "s1",
      cwd: "/abs",
      projectSlug: "demo",
      contextUsage: null,
      ts: 1700,
    });

    expect(row.processor).toBe("passthrough");
    expect(row.before_bytes).toBe(2048);
    expect(row.after_bytes).toBe(2048);
  });

  test("OMP-minimized bash output is marked omp-minimizer rather than bash", () => {
    const minimized = "first line\n[raw output: artifact://abc-DEF_123]";
    const row = toMetricRow({
      event: eventFor("bash", { command: "ls -la" }, minimized),
      compressed: undefined,
      sessionId: "s1",
      cwd: "/repo",
      projectSlug: "demo",
      contextUsage: null,
      ts: 1700,
    });

    expect(row.processor).toBe("omp-minimizer");
    expect(row.tool).toBe("bash");
  });
});

describe("toMetricRow — non-tool / unknown events (Task 19)", () => {
  test("empty toolName yields '(system)' tool, null processor, null hash", () => {
    const row = toMetricRow({
      event: eventFor("", {}, "x"),
      compressed: undefined,
      sessionId: "s1",
      cwd: "/repo",
      projectSlug: "demo",
      contextUsage: null,
      ts: 1700,
    });

    expect(row.tool).toBe("(system)");
    expect(row.processor).toBeNull();
    expect(row.unique_source_hash).toBeNull();
  });

  test("unknown tool name yields '(system)' tool and null hash", () => {
    const row = toMetricRow({
      event: eventFor("noSuchTool", { arg: 1 }, "x"),
      compressed: undefined,
      sessionId: "s1",
      cwd: "/repo",
      projectSlug: "demo",
      contextUsage: null,
      ts: 1700,
    });

    expect(row.tool).toBe("(system)");
    expect(row.processor).toBeNull();
    expect(row.unique_source_hash).toBeNull();
  });
});
