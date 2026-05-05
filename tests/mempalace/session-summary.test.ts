import { describe, expect, test } from "bun:test";
import {
  buildCompactionCheckpoint,
  buildShutdownDiary,
} from "../../src/mempalace/session-summary.js";

function fakeEventStore(events: Array<{ category: string; data: unknown; timestamp?: number }>) {
  return {
    getEventCounts: () => ({
      file: 0,
      git: 0,
      error: 0,
      task: events.filter((event) => event.category === "task").length,
      cwd: 0,
      mcp: 0,
      subagent: 0,
      prompt: 0,
      decision: events.filter((event) => event.category === "decision").length,
      rule: events.filter((event) => event.category === "rule").length,
      env: 0,
      skill: 0,
      intent: events.filter((event) => event.category === "intent").length,
    }),
    getEvents: (_sessionId: string, filters?: { categories?: string[] }) => events
      .filter((event) => !filters?.categories || filters.categories.includes(event.category))
      .map((event, index) => ({
        id: index + 1,
        sessionId: "session-1",
        category: event.category,
        data: JSON.stringify(event.data),
        priority: 3,
        source: "test",
        timestamp: event.timestamp ?? index + 1,
      })),
  };
}

describe("mempalace session summaries", () => {
  test("builds compaction checkpoint from event-store decisions, tasks, intents, and rules", () => {
    const checkpoint = buildCompactionCheckpoint({
      cwd: "/repo",
      sessionId: "session-1",
      wing: "supipowers",
      defaultAgentName: "omp",
      now: "2026-05-04T12:00:00.000Z",
      eventStore: fakeEventStore([
        { category: "decision", data: { prompt: "Use MemPalace natively" } },
        { category: "task", data: { input: { ops: [{ op: "done", task: "Implement bridge" }] } } },
        { category: "intent", data: { intent: "fix", prompt: "fix the bug" } },
        { category: "rule", data: { path: "AGENTS.md" } },
      ]) as any,
    });

    expect(checkpoint.content).toContain("MemPalace compaction checkpoint");
    expect(checkpoint.content).toContain("Use MemPalace natively");
    expect(checkpoint.content).toContain("Implement bridge");
    expect(checkpoint.content).toContain("fix the bug");
    expect(checkpoint.content).toContain("AGENTS.md");
    expect(checkpoint.metadata).toMatchObject({
      wing: "supipowers",
      room: "compaction-checkpoints",
      added_by: "omp",
      source_file: "omp-session:session-1:compaction:2026-05-04T12:00:00.000Z",
    });
  });

  test("falls back to session manager branch entries", () => {
    const checkpoint = buildCompactionCheckpoint({
      cwd: "/repo",
      sessionId: "session-2",
      wing: "project",
      defaultAgentName: "omp",
      now: "2026-05-04T12:00:00.000Z",
      sessionManager: {
        getBranch: () => [
          { role: "user", content: "Need release notes" },
          { role: "assistant", content: [{ type: "text", text: "Prepared release notes" }] },
        ],
      },
    });

    expect(checkpoint.content).toContain("Session branch fallback");
    expect(checkpoint.content).toContain("Need release notes");
    expect(checkpoint.content).toContain("Prepared release notes");
  });

  test("uses a no-data fallback when structured session data is unavailable", () => {
    const checkpoint = buildCompactionCheckpoint({
      cwd: "/repo",
      sessionId: "session-3",
      wing: "project",
      defaultAgentName: "omp",
      now: "2026-05-04T12:00:00.000Z",
    });

    expect(checkpoint.content).toContain("Structured session data unavailable.");
    expect(checkpoint.content).toContain("reason: compaction");
  });

  test("builds shutdown diary metadata with default agent and project wing", () => {
    const diary = buildShutdownDiary({
      cwd: "/repo",
      sessionId: "session-4",
      wing: "supipowers",
      defaultAgentName: "omp",
      now: "2026-05-04T12:00:00.000Z",
    });

    expect(diary.entry).toContain("MemPalace shutdown diary");
    expect(diary.entry).toContain("Structured session data unavailable.");
    expect(diary.metadata).toEqual({
      agent_name: "omp",
      wing: "supipowers",
      topic: "shutdown",
      timestamp: "2026-05-04T12:00:00.000Z",
      source_file: "omp-session:session-4:shutdown:2026-05-04T12:00:00.000Z",
    });
  });
});
