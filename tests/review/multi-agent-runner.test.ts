import { describe, expect, mock, test } from "bun:test";
import { buildConfiguredAgentPrompt, runMultiAgentReview } from "../../src/review/multi-agent-runner.js";
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
  const prompts: string[] = [];
  const fn = mock(async (options: any) => {
    calls.push(options);
    const session: AgentSession = {
      subscribe: () => () => {},
      prompt: mock(async (prompt: string) => {
        prompts.push(prompt);
      }),
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
  return { fn, calls, prompts };
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

describe("package-aware scope context", () => {
  test("passes selected package descriptions and filtered diffs into agent prompts", () => {
    const prompt = buildConfiguredAgentPrompt(
      makeAgent(),
      {
        ...EMPTY_SCOPE,
        description: "Reviewing uncommitted changes for api (packages/api)",
        diff: [
          "diff --git a/packages/api/src/index.ts b/packages/api/src/index.ts",
          "--- a/packages/api/src/index.ts",
          "+++ b/packages/api/src/index.ts",
          "@@ -1 +1 @@",
          "+export const api = true;",
        ].join("\n"),
        files: [
          {
            path: "packages/api/src/index.ts",
            additions: 1,
            deletions: 0,
            diff: "@@ -1 +1 @@",
          },
        ],
      },
    );

    expect(prompt).toContain("Reviewing uncommitted changes for api (packages/api)");
    expect(prompt).toContain("packages/api/src/index.ts");
    expect(prompt).not.toContain("packages/web/src/index.ts");
  });
});

describe("IRC peer coordination", () => {
  test("injects IRC block when two agents opt in and `irc` is active", async () => {
    const { fn, prompts, calls } = createMockSession();
    await runMultiAgentReview({
      cwd: "/fake",
      scope: EMPTY_SCOPE,
      agents: [
        makeAgent({ name: "alpha", peerCoordination: true }),
        makeAgent({ name: "beta", peerCoordination: true }),
      ],
      createAgentSession: fn as any,
      activeTools: ["irc", "open", "bash"],
    });

    expect(prompts).toHaveLength(2);
    const [alphaPrompt, betaPrompt] = prompts;
    expect(alphaPrompt).toContain("## IRC peer coordination");
    expect(alphaPrompt).toContain("`supi-review-alpha`");
    expect(alphaPrompt).toContain("`supi-review-beta`");
    expect(betaPrompt).toContain("`supi-review-alpha`");
    expect(betaPrompt).toContain("`supi-review-beta`");
    expect(calls.map((call) => call.agentId)).toEqual([
      "supi-review-alpha",
      "supi-review-beta",
    ]);
    expect(calls.map((call) => call.agentDisplayName)).toEqual(["alpha", "beta"]);
  });

  test("sanitizes duplicate peer names into registered IRC ids", async () => {
    const { fn, prompts, calls } = createMockSession();
    await runMultiAgentReview({
      cwd: "/fake",
      scope: EMPTY_SCOPE,
      agents: [
        makeAgent({ name: "Alpha Agent", peerCoordination: true }),
        makeAgent({ name: "Alpha/Agent", peerCoordination: true }),
      ],
      createAgentSession: fn as any,
      activeTools: ["irc"],
    });

    expect(calls.map((call) => call.agentId)).toEqual([
      "supi-review-alpha-agent",
      "supi-review-alpha-agent-2",
    ]);
    expect(prompts[0]).toContain("`supi-review-alpha-agent-2`");
    expect(prompts[1]).toContain("`supi-review-alpha-agent`");
  });

  test("omits IRC block when `irc` is not in activeTools", async () => {
    const { fn, prompts } = createMockSession();
    await runMultiAgentReview({
      cwd: "/fake",
      scope: EMPTY_SCOPE,
      agents: [
        makeAgent({ name: "alpha", peerCoordination: true }),
        makeAgent({ name: "beta", peerCoordination: true }),
      ],
      createAgentSession: fn as any,
      activeTools: ["open", "bash"],
    });

    for (const prompt of prompts) {
      expect(prompt).not.toContain("## IRC peer coordination");
    }
  });

  test("omits IRC block when peerCoordination is unset (default)", async () => {
    const { fn, prompts } = createMockSession();
    await runMultiAgentReview({
      cwd: "/fake",
      scope: EMPTY_SCOPE,
      agents: [
        makeAgent({ name: "alpha" }),
        makeAgent({ name: "beta" }),
      ],
      createAgentSession: fn as any,
      activeTools: ["irc"],
    });

    for (const prompt of prompts) {
      expect(prompt).not.toContain("## IRC peer coordination");
    }
  });

  test("omits IRC block when only one agent opted in (no peers)", async () => {
    const { fn, prompts } = createMockSession();
    await runMultiAgentReview({
      cwd: "/fake",
      scope: EMPTY_SCOPE,
      agents: [
        makeAgent({ name: "alpha", peerCoordination: true }),
        makeAgent({ name: "beta" }),
      ],
      createAgentSession: fn as any,
      activeTools: ["irc"],
    });

    for (const prompt of prompts) {
      expect(prompt).not.toContain("## IRC peer coordination");
    }
  });
});
