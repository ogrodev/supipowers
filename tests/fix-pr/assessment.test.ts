import { describe, expect, test } from "bun:test";
import type { AgentSession } from "../../src/platform/types.js";
import {
  runFixPrAssessment,
  groupAssessmentsIntoBatches,
} from "../../src/fix-pr/assessment.js";
import type { FixPrAssessmentBatch } from "../../src/fix-pr/contracts.js";
import type { PrComment } from "../../src/fix-pr/types.js";

function comment(id: number, path: string | null): PrComment {
  return {
    id,
    path,
    line: 1,
    body: `body ${id}`,
    user: "reviewer",
    userType: "User",
    createdAt: "2026-04-16T00:00:00Z",
    updatedAt: "2026-04-16T00:00:00Z",
    inReplyToId: null,
    diffHunk: null,
    state: "COMMENTED",
  };
}

function makeFakeSessionFactory(responses: Array<string | Error>) {
  let callIndex = 0;
  const createAgentSession = async (): Promise<AgentSession> => {
    const idx = callIndex;
    callIndex += 1;
    const messages: any[] = [];
    return {
      state: {
        get messages() {
          return messages;
        },
      },
      async prompt() {
        const next = responses[idx];
        if (next instanceof Error) throw next;
        messages.push({ role: "assistant", content: next ?? "" });
      },
      async dispose() {
        // no-op
      },
    } as unknown as AgentSession;
  };
  return createAgentSession;
}

describe("runFixPrAssessment", () => {
  test("returns empty batch without calling the AI when cluster is empty", async () => {
    let called = 0;
    const factory = async () => {
      called += 1;
      return {} as unknown as AgentSession;
    };
    const result = await runFixPrAssessment({
      createAgentSession: factory as any,
      cwd: "/tmp",
      comments: [],
      repo: "owner/repo",
      prNumber: 1,
      selectedTargetLabel: "root (.)",
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output.assessments).toEqual([]);
      expect(result.attempts).toBe(0);
    }
    expect(called).toBe(0);
  });

  test("parses a valid artifact on first attempt", async () => {
    const valid = JSON.stringify({
      assessments: [
        {
          commentId: 10,
          verdict: "apply",
          rationale: "The suggestion matches actual code behaviour.",
          affectedFiles: ["src/foo.ts"],
          rippleEffects: [],
          verificationPlan: "Run bun test src/foo.test.ts.",
        },
      ],
    });
    const factory = makeFakeSessionFactory([valid]);
    const result = await runFixPrAssessment({
      createAgentSession: factory as any,
      cwd: "/tmp",
      comments: [comment(10, "src/foo.ts")],
      repo: "owner/repo",
      prNumber: 1,
      selectedTargetLabel: "root (.)",
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output.assessments).toHaveLength(1);
      expect(result.output.assessments[0].verdict).toBe("apply");
    }
  });

  test("rejects invalid verdict and surfaces blocked status after retries", async () => {
    const invalid = JSON.stringify({
      assessments: [
        {
          commentId: 10,
          verdict: "accept",
          rationale: "...",
          affectedFiles: [],
          rippleEffects: [],
          verificationPlan: "...",
        },
      ],
    });
    const factory = makeFakeSessionFactory([invalid, invalid, invalid]);
    const result = await runFixPrAssessment({
      createAgentSession: factory as any,
      cwd: "/tmp",
      comments: [comment(10, "src/foo.ts")],
      repo: "owner/repo",
      prNumber: 1,
      selectedTargetLabel: "root (.)",
      maxAttempts: 3,
    });
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.attempts).toBe(3);
      expect(result.error.toLowerCase()).toContain("verdict");
    }
  });

  test("returns blocked when retries exhaust on malformed JSON", async () => {
    const factory = makeFakeSessionFactory(["nope", "still nope"]);
    const result = await runFixPrAssessment({
      createAgentSession: factory as any,
      cwd: "/tmp",
      comments: [comment(10, "src/foo.ts")],
      repo: "owner/repo",
      prNumber: 1,
      selectedTargetLabel: "root (.)",
      maxAttempts: 2,
    });
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.attempts).toBe(2);
      expect(result.rawOutputs).toHaveLength(2);
    }
  });
});

describe("groupAssessmentsIntoBatches", () => {
  function assessment(
    commentId: number,
    verdict: "apply" | "reject" | "investigate",
    affectedFiles: string[],
  ) {
    return {
      commentId,
      verdict,
      rationale: "r",
      affectedFiles,
      rippleEffects: [],
      verificationPlan: "v",
    };
  }

  test("returns empty list when no apply verdicts exist", () => {
    const batch: FixPrAssessmentBatch = {
      assessments: [
        assessment(1, "reject", []),
        assessment(2, "investigate", ["src/a.ts"]),
      ],
    };
    expect(groupAssessmentsIntoBatches(batch)).toEqual([]);
  });

  test("groups apply assessments sharing files; singletons stay separate", () => {
    const batch: FixPrAssessmentBatch = {
      assessments: [
        assessment(3, "apply", ["src/a.ts"]),
        assessment(1, "apply", ["src/a.ts", "src/b.ts"]),
        assessment(2, "apply", ["src/c.ts"]),
        assessment(4, "reject", ["src/a.ts"]),
        assessment(5, "apply", []),
      ],
    };
    const batches = groupAssessmentsIntoBatches(batch);
    expect(batches).toEqual([
      {
        id: "batch-1",
        commentIds: [1, 3],
        affectedFiles: ["src/a.ts", "src/b.ts"],
      },
      { id: "batch-2", commentIds: [2], affectedFiles: ["src/c.ts"] },
      { id: "batch-5", commentIds: [5], affectedFiles: [] },
    ]);
  });

  test("grouping is deterministic regardless of input order", () => {
    const a: FixPrAssessmentBatch = {
      assessments: [
        assessment(10, "apply", ["x.ts"]),
        assessment(20, "apply", ["y.ts", "x.ts"]),
        assessment(30, "apply", ["y.ts"]),
      ],
    };
    const b: FixPrAssessmentBatch = {
      assessments: [
        assessment(30, "apply", ["y.ts"]),
        assessment(20, "apply", ["x.ts", "y.ts"]),
        assessment(10, "apply", ["x.ts"]),
      ],
    };
    expect(groupAssessmentsIntoBatches(a)).toEqual(groupAssessmentsIntoBatches(b));
  });

  test("merges transitive file overlaps via shared files", () => {
    const batch: FixPrAssessmentBatch = {
      assessments: [
        assessment(1, "apply", ["a.ts"]),
        assessment(2, "apply", ["a.ts", "b.ts"]),
        assessment(3, "apply", ["b.ts", "c.ts"]),
        assessment(4, "apply", ["d.ts"]),
      ],
    };
    const batches = groupAssessmentsIntoBatches(batch);
    expect(batches).toHaveLength(2);
    expect(batches[0].commentIds).toEqual([1, 2, 3]);
    expect(batches[0].affectedFiles).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(batches[1].commentIds).toEqual([4]);
  });
});
