import { describe, expect, mock, test } from "bun:test";
import { runMultiAgentReview } from "../../src/review/multi-agent-runner.js";
import type { ConfiguredReviewAgent, ReviewScope } from "../../src/types.js";
import type { AgentSession } from "../../src/platform/types.js";

function makeAgent(overrides: Partial<ConfiguredReviewAgent> = {}): ConfiguredReviewAgent {
  return {
    name: "test-agent",
    description: "Test agent",
    focus: null,
    prompt: "Review this code.\n\n{output_instructions}",
    filePath: "/fake/test-agent.md",
    enabled: true,
    data: "test-agent.md",
    model: null,
    thinkingLevel: null,
    ...overrides,
  };
}

const EMPTY_SCOPE: ReviewScope = {
  mode: "uncommitted",
  description: "test",
  diff: "",
  files: [{ path: "src/index.ts", additions: 0, deletions: 0, diff: "" }],
  stats: { filesChanged: 1, excludedFiles: 0, additions: 0, deletions: 0 },
};

const VALID_REVIEW_OUTPUT = JSON.stringify({
  findings: [],
  summary: "No issues found",
  status: "passed",
});

function createMockSession() {
  const calls: any[] = [];
  const fn = mock(async (options: any) => {
    calls.push(options);
    const session: AgentSession = {
      subscribe: () => () => {},
      prompt: mock(async () => {}),
      state: {
        messages: [
          { role: "user", content: "test" },
          { role: "assistant", content: [{ type: "text", text: VALID_REVIEW_OUTPUT }] },
        ],
      },
      dispose: mock(async () => {}),
    };
    return session;
  });
  return { fn, calls };
}

describe("thinkingLevel override", () => {
  test("uses agent thinkingLevel when set", async () => {
    const { fn, calls } = createMockSession();
    await runMultiAgentReview({
      cwd: "/fake",
      scope: EMPTY_SCOPE,
      agents: [makeAgent({ thinkingLevel: "high" })],
      createAgentSession: fn as any,
      thinkingLevel: "low",
    });
    expect(calls[0].thinkingLevel).toBe("high");
  });

  test("falls back to pipeline thinkingLevel when agent is null", async () => {
    const { fn, calls } = createMockSession();
    await runMultiAgentReview({
      cwd: "/fake",
      scope: EMPTY_SCOPE,
      agents: [makeAgent({ thinkingLevel: null })],
      createAgentSession: fn as any,
      thinkingLevel: "medium",
    });
    expect(calls[0].thinkingLevel).toBe("medium");
  });

  test("uses null when both agent and pipeline are null", async () => {
    const { fn, calls } = createMockSession();
    await runMultiAgentReview({
      cwd: "/fake",
      scope: EMPTY_SCOPE,
      agents: [makeAgent({ thinkingLevel: null })],
      createAgentSession: fn as any,
      thinkingLevel: null,
    });
    expect(calls[0].thinkingLevel).toBeNull();
  });

  test("uses null when both agent and pipeline are undefined/null", async () => {
    const { fn, calls } = createMockSession();
    await runMultiAgentReview({
      cwd: "/fake",
      scope: EMPTY_SCOPE,
      agents: [makeAgent({ thinkingLevel: null })],
      createAgentSession: fn as any,
      // thinkingLevel not set — exercises the undefined path
    });
    expect(calls[0].thinkingLevel).toBeNull();
  });
});
