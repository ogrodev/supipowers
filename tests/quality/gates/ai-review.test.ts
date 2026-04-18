import { describe, expect, mock, test } from "bun:test";
import type { AgentSession } from "../../../src/platform/types.js";
import {
  buildAiReviewPrompt,
  runAiReview,
} from "../../../src/quality/gates/ai-review.js";

function createAgentSessionFactory(finalTexts: string[]) {
  const calls: any[] = [];
  const prompts: string[] = [];
  let index = 0;
  const factory = mock(async (options: any) => {
    calls.push(options);
    const text = finalTexts[Math.min(index, finalTexts.length - 1)];
    index += 1;
    const session: AgentSession = {
      subscribe: () => () => {},
      prompt: async (promptText: string) => {
        prompts.push(promptText);
      },
      state: {
        messages: [
          { role: "user", content: "go" },
          { role: "assistant", content: [{ type: "text", text }] },
        ],
      },
      dispose: async () => {},
    } as unknown as AgentSession;
    return session;
  });
  return { factory, calls, prompts };
}

const VALID_OUTPUT = JSON.stringify({
  summary: "Looks fine",
  issues: [
    { severity: "warning", message: "check this", file: "src/a.ts", line: 5 },
  ],
  recommendedStatus: "failed",
});

describe("buildAiReviewPrompt", () => {
  test("embeds the rendered schema so retries see the structural contract", () => {
    const prompt = buildAiReviewPrompt(["src/a.ts"], "changed-files", "quick");
    expect(prompt).toContain("summary: string;");
    expect(prompt).toContain("recommendedStatus:");
    expect(prompt).toContain('"passed"');
    expect(prompt).toContain('"failed"');
    expect(prompt).toContain('"blocked"');
    expect(prompt).toContain("issues:");
    expect(prompt).toContain("- src/a.ts");
  });

  test("uses depth-appropriate guidance", () => {
    expect(buildAiReviewPrompt([], "all-files", "deep")).toContain("Review deeply");
    expect(buildAiReviewPrompt([], "all-files", "quick")).toContain("Focus on obvious");
  });
});

describe("runAiReview", () => {
  test("maps recommendedStatus into the gate result on valid output", async () => {
    const { factory, calls } = createAgentSessionFactory([VALID_OUTPUT]);

    const result = await runAiReview(
      {
        cwd: "/tmp/project",
        scopeFiles: ["src/a.ts"],
        fileScope: "changed-files",
        createAgentSession: factory as any,
        reviewModel: { model: "m", thinkingLevel: "high" },
      },
      "quick",
    );

    expect(calls).toHaveLength(1);
    expect(result.status).toBe("failed");
    expect(result.summary).toBe("Looks fine");
    expect(result.issues).toEqual([
      { severity: "warning", message: "check this", file: "src/a.ts", line: 5 },
    ]);
    expect(result.metadata).toMatchObject({ depth: "quick", attempts: 1 });
  });

  test("retries once with validator feedback then succeeds", async () => {
    const { factory, calls, prompts } = createAgentSessionFactory(["not json", VALID_OUTPUT]);

    const result = await runAiReview(
      {
        cwd: "/tmp/project",
        scopeFiles: [],
        fileScope: "all-files",
        createAgentSession: factory as any,
      },
      "deep",
    );

    expect(calls).toHaveLength(2);
    expect(result.status).toBe("failed");
    // Retry prompt must include the previous invalid output and the schema.
    expect(prompts[1]).toContain("not json");
    expect(prompts[1]).toContain("recommendedStatus:");
  });

  test("returns blocked with preserved error when retries exhaust on malformed JSON", async () => {
    const { factory, calls } = createAgentSessionFactory([
      "not json",
      "still not json",
      "still not json either",
    ]);

    const result = await runAiReview(
      {
        cwd: "/tmp/project",
        scopeFiles: [],
        fileScope: "all-files",
        createAgentSession: factory as any,
      },
      "quick",
    );

    expect(calls).toHaveLength(3);
    expect(result.status).toBe("blocked");
    expect(result.issues).toEqual([]);
    expect(result.summary).toMatch(/Invalid JSON/i);
    expect(result.metadata).toMatchObject({ depth: "quick", attempts: 3 });
    expect((result.metadata as any).rawOutputs).toHaveLength(3);
  });

  test("returns blocked with field-level validation feedback on schema mismatch", async () => {
    const bad = JSON.stringify({
      summary: "ok",
      issues: [{ severity: "critical", message: "nope" }],
      recommendedStatus: "failed",
    });
    const { factory } = createAgentSessionFactory([bad, bad, bad]);

    const result = await runAiReview(
      {
        cwd: "/tmp/project",
        scopeFiles: [],
        fileScope: "all-files",
        createAgentSession: factory as any,
      },
      "quick",
    );

    expect(result.status).toBe("blocked");
    expect(result.summary).toContain("issues.0.severity");
  });
});
