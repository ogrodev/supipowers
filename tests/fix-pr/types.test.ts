
import type {
  FixPrConfig,
  ModelPref,
  PrComment,
  CommentVerdict,
  FixGroup,
  FixPrSessionLedger,
} from "../../src/fix-pr/types.js";

describe("FixPr types", () => {
  test("FixPrConfig has all required fields", () => {
    const config: FixPrConfig = {
      reviewer: { type: "coderabbit", triggerMethod: "/review" },
      commentPolicy: "answer-selective",
      loop: { delaySeconds: 180, maxIterations: 3 },
      models: {
        orchestrator: { provider: "anthropic", model: "claude-opus-4-6", tier: "high" },
        planner: { provider: "openai", model: "gpt-5.4", tier: "high" },
        fixer: { provider: "anthropic", model: "claude-sonnet-4-6", tier: "low" },
      },
    };
    expect(config.reviewer.type).toBe("coderabbit");
    expect(config.commentPolicy).toBe("answer-selective");
    expect(config.loop.delaySeconds).toBe(180);
    expect(config.models.orchestrator.provider).toBe("anthropic");
  });

  test("ModelPref has provider, model, tier", () => {
    const pref: ModelPref = { provider: "anthropic", model: "claude-opus-4-6", tier: "high" };
    expect(pref.provider).toBeTruthy();
    expect(pref.model).toBeTruthy();
    expect(["low", "high"]).toContain(pref.tier);
  });

  test("PrComment has all fields", () => {
    const comment: PrComment = {
      id: 123,
      path: "src/foo.ts",
      line: 42,
      body: "This needs fixing",
      user: "reviewer",
      createdAt: "2026-03-12T00:00:00Z",
      updatedAt: "2026-03-12T00:00:00Z",
      inReplyToId: null,
      diffHunk: "@@ -1,3 +1,3 @@",
      state: "COMMENTED",
      userType: "User",
    };
    expect(comment.id).toBe(123);
    expect(comment.path).toBe("src/foo.ts");
  });

  test("CommentVerdict is accept, reject, or investigate", () => {
    const verdicts: CommentVerdict[] = ["accept", "reject", "investigate"];
    expect(verdicts).toHaveLength(3);
  });

  test("FixGroup has required fields", () => {
    const group: FixGroup = {
      id: "group-a",
      commentIds: [1, 2, 3],
      files: ["src/foo.ts"],
      description: "Fix error handling",
    };
    expect(group.id).toBe("group-a");
    expect(group.commentIds).toHaveLength(3);
  });

  test("FixPrSessionLedger has required fields", () => {
    const ledger: FixPrSessionLedger = {
      id: "fpr-20260312-143000-a1b2",
      createdAt: "2026-03-12T14:30:00Z",
      updatedAt: "2026-03-12T14:30:00Z",
      prNumber: 123,
      repo: "owner/repo",
      status: "running",
      iteration: 0,
      config: {
        reviewer: { type: "none", triggerMethod: null },
        commentPolicy: "no-answer",
        loop: { delaySeconds: 180, maxIterations: 3 },
        models: {
          orchestrator: { provider: "anthropic", model: "claude-opus-4-6", tier: "high" },
          planner: { provider: "anthropic", model: "claude-opus-4-6", tier: "high" },
          fixer: { provider: "anthropic", model: "claude-sonnet-4-6", tier: "low" },
        },
      },
      commentsProcessed: [],
    };
    expect(ledger.prNumber).toBe(123);
    expect(ledger.status).toBe("running");
    expect(ledger.commentsProcessed).toEqual([]);
  });

  test("reviewer types are exhaustive", () => {
    const types: FixPrConfig["reviewer"]["type"][] = ["coderabbit", "copilot", "gemini", "none"];
    expect(types).toHaveLength(4);
  });

  test("comment policies are exhaustive", () => {
    const policies: FixPrConfig["commentPolicy"][] = ["answer-all", "answer-selective", "no-answer"];
    expect(policies).toHaveLength(3);
  });
});
