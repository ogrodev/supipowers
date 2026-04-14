import { describe, expect, mock, test } from "bun:test";
import type { Platform } from "../../src/platform/types.js";
import { runAiReviewSessionForTest } from "../../src/commands/ai-review.js";
import type { AiReviewCommandDependencies } from "../../src/commands/ai-review.js";
import type {
  ConfiguredReviewAgent,
  ReviewFixOutput,
  ReviewOutput,
  ReviewScope,
  ReviewSession,
} from "../../src/types.js";

const BASE_SCOPE: ReviewScope = {
  mode: "uncommitted",
  description: "Changed files in working tree",
  diff: "diff --git a/src/example.ts b/src/example.ts",
  files: [
    {
      path: "src/example.ts",
      additions: 4,
      deletions: 1,
      diff: "@@ -1 +1 @@",
    },
  ],
  stats: {
    filesChanged: 1,
    excludedFiles: 0,
    additions: 4,
    deletions: 1,
  },
};

const FINDING = {
  id: "finding-1",
  title: "Missing guard",
  severity: "error" as const,
  priority: "P1" as const,
  confidence: 0.91,
  file: "src/example.ts",
  lineStart: 14,
  lineEnd: 14,
  body: "Add a guard before calling the fixer.",
  suggestion: "Return early when the input is empty.",
};

const OUTPUT_WITH_FINDINGS: ReviewOutput = {
  status: "failed",
  summary: "1 finding requires attention.",
  findings: [FINDING],
};

const OUTPUT_WITHOUT_FINDINGS: ReviewOutput = {
  status: "passed",
  summary: "No findings.",
  findings: [],
};

const FIX_OUTPUT: ReviewFixOutput = {
  status: "applied",
  summary: "Applied 1 safe fix.",
  fixes: [
    {
      findingIds: [FINDING.id],
      file: FINDING.file,
      status: "applied",
      summary: "Inserted the missing guard.",
    },
  ],
};

function cloneSession(session: ReviewSession): ReviewSession {
  return JSON.parse(JSON.stringify(session)) as ReviewSession;
}

function createPlatform(events: string[] = []): Platform {
  return {
    name: "omp",
    registerCommand: mock(),
    getCommands: mock(() => []),
    on: mock(),
    exec: mock(),
    sendMessage: mock(),
    sendUserMessage: mock((message: string) => {
      events.push(`sendUserMessage:${message}`);
    }),
    getActiveTools: mock(() => []),
    registerMessageRenderer: mock(),
    createAgentSession: mock(),
    paths: {
      dotDir: ".omp",
      dotDirDisplay: ".omp",
      project: (_cwd: string, ...segments: string[]) => segments.join("/"),
      global: (...segments: string[]) => segments.join("/"),
      agent: (...segments: string[]) => segments.join("/"),
    },
    capabilities: {
      agentSessions: true,
      compactionHooks: false,
      customWidgets: true,
      registerTool: false,
    },
  } as unknown as Platform;
}

function createContext(options: {
  selectResponses?: Array<string | null>;
  customResult?: string | null;
  includeCustom?: boolean;
  onCustomFactory?: (factory: unknown) => void;
} = {}) {
  const selectResponses = [...(options.selectResponses ?? [])];
  const ui: Record<string, any> = {
    notify: mock(),
    select: mock(async () => (selectResponses.length > 0 ? selectResponses.shift() ?? null : null)),
    input: mock(async () => "3"),
    setStatus: mock(),
    setWidget: mock(),
  };

  if (options.includeCustom !== false) {
    ui.custom = mock(async (factory: unknown) => {
      options.onCustomFactory?.(factory);
      return options.customResult ?? null;
    });
  }

  return {
    cwd: "/repo",
    hasUI: true,
    ui,
    modelRegistry: { getAvailable: () => [] },
  } as any;
}

function createDependencies(options: {
  reviewOutput?: ReviewOutput;
  validationOutput?: ReviewOutput;
  consolidatedOutput?: ReviewOutput;
  level?: "quick" | "deep" | "multi-agent";
  events?: string[];
  sessions?: ReviewSession[];
  updates?: ReviewSession[];
  artifacts?: string[];
  artifactContents?: Array<{ path: string; content: unknown }>;
} = {}): AiReviewCommandDependencies {
  const events = options.events ?? [];
  const sessions = options.sessions ?? [];
  const updates = options.updates ?? [];
  const artifacts = options.artifacts ?? [];
  const artifactContents = options.artifactContents ?? [];
  const reviewOutput = options.reviewOutput ?? OUTPUT_WITH_FINDINGS;
  const validationOutput = options.validationOutput ?? {
    ...reviewOutput,
    findings: reviewOutput.findings,
  };
  const consolidatedOutput = options.consolidatedOutput ?? {
    ...validationOutput,
    summary: "Consolidated to 1 unique finding.",
  };
  const agents: ConfiguredReviewAgent[] = options.level === "multi-agent"
    ? [
        {
          name: "security",
          description: "Security review",
          focus: "security",
          prompt: "Review security findings",
          filePath: "agents/security.md",
          enabled: true,
          data: "project",
          model: null,
        },
      ]
    : [];

  return {
    loadModelConfig: mock(() => ({ version: "1.0.0", default: null, actions: {} })),
    createModelBridge: mock(() => ({ getModelForRole: () => null, getCurrentModel: () => "unknown" })),
    resolveModelForAction: mock(() => ({
      model: "anthropic/claude-opus-4-6",
      thinkingLevel: "high" as const,
      source: "action" as const,
    })),
    selectReviewScope: mock(async () => BASE_SCOPE),
    loadReviewAgents: mock(async () => ({ agents })),
    runQuickReview: mock(async () => ({ output: reviewOutput })),
    runDeepReview: mock(async () => ({ output: reviewOutput })),
    runMultiAgentReview: mock(async () => ({
      output: reviewOutput,
      agents: agents.map((agent) => ({ agent, output: reviewOutput })),
    })),
    validateReviewFindings: mock(async () => ({
      output: validationOutput,
    })),
    consolidateReviewOutputs: mock(() => consolidatedOutput),
    runAutoFix: mock(async () => ({ output: FIX_OUTPUT })),
    createReviewSession: mock((_paths, _cwd, session) => {
      events.push(`createReviewSession:${session.id}`);
      sessions.push(cloneSession(session));
    }),
    updateReviewSession: mock((_paths, _cwd, session) => {
      events.push(`updateReviewSession:${session.id}`);
      updates.push(cloneSession(session));
    }),
    writeReviewArtifact: mock((_paths, _cwd, sessionId, relativePath, content) => {
      events.push(`writeReviewArtifact:${sessionId}:${relativePath}`);
      artifacts.push(relativePath);
      artifactContents.push({ path: relativePath, content });
      return `/repo/.omp/supipowers/reviews/${sessionId}/${relativePath}`;
    }),
    generateReviewSessionId: mock(() => "review-test-session"),
    notifyInfo: mock(),
  } as unknown as AiReviewCommandDependencies;
}

function getSavedSession(updates: ReviewSession[]): ReviewSession {
  const session = updates.at(-1);
  expect(session).toBeDefined();
  return session as ReviewSession;
}

function getRenderedWidgetTexts(ctx: any): string[] {
  return ctx.ui.setWidget.mock.calls
    .map((call: any[]) => call[1])
    .filter((factory: unknown) => typeof factory === "function")
    .map((factory: any) => factory())
    .filter((component: any) => component && typeof component.getText === "function")
    .map((component: any) => component.getText());
}

describe("runAiReviewSessionForTest", () => {
  test("always validates findings, writes findings.md, and Fix now continues into auto-fix", async () => {
    const platform = createPlatform();
    const ctx = createContext({
      includeCustom: false,
      selectResponses: [
        "Quick — fast high-signal review",
        "Fix now",
        "No",
      ],
    });
    const updates: ReviewSession[] = [];
    const artifacts: string[] = [];
    const deps = createDependencies({ updates, artifacts });

    await runAiReviewSessionForTest(platform, ctx, deps);

    expect(deps.validateReviewFindings).toHaveBeenCalledTimes(1);
    expect(deps.runAutoFix).toHaveBeenCalledTimes(1);
    expect(artifacts.filter((artifact) => artifact === "findings.md")).toHaveLength(2);
    expect(deps.notifyInfo).toHaveBeenCalledWith(
      ctx,
      "AI review complete: post-fix verification pending",
      expect.stringContaining("findings.md (pre-fix snapshot)"),
    );
    expect(getSavedSession(updates) as any).toMatchObject({
      validateFindings: true,
      consolidate: false,
      postConsolidationAction: "fix-now",
      artifacts: {
        findingsReport: "findings.md",
      },
    });
  });

  test("cancelling after an applied fix rewrites findings.md as a pre-fix snapshot", async () => {
    const platform = createPlatform();
    const ctx = createContext({
      includeCustom: false,
      selectResponses: [
        "Quick — fast high-signal review",
        "Fix now",
      ],
    });
    const updates: ReviewSession[] = [];
    const artifacts: string[] = [];
    const artifactContents: Array<{ path: string; content: unknown }> = [];
    const deps = createDependencies({ updates, artifacts, artifactContents });

    await runAiReviewSessionForTest(platform, ctx, deps);

    expect(deps.runAutoFix).toHaveBeenCalledTimes(1);
    expect(artifacts.filter((artifact) => artifact === "findings.md")).toHaveLength(2);
    expect(deps.notifyInfo).not.toHaveBeenCalled();
    expect(getSavedSession(updates)).toMatchObject({
      status: "cancelled",
      postConsolidationAction: "fix-now",
      artifacts: {
        findingsReport: "findings.md",
      },
    });
    expect(artifactContents.at(-1)).toMatchObject({
      path: "findings.md",
      content: expect.stringContaining("Snapshot: pre-fix review output"),
    });
  });

  test("marks findings.md as a pre-fix snapshot when the review loop ends right after another fix", async () => {
    const platform = createPlatform();
    const ctx = createContext({
      includeCustom: false,
      selectResponses: [
        "Quick — fast high-signal review",
        "Fix now",
        "Yes",
      ],
    });
    const updates: ReviewSession[] = [];
    const artifacts: string[] = [];
    const deps = createDependencies({ updates, artifacts });

    await runAiReviewSessionForTest(platform, ctx, deps);

    expect(deps.validateReviewFindings).toHaveBeenCalledTimes(3);
    expect(deps.runAutoFix).toHaveBeenCalledTimes(3);
    expect(artifacts.filter((artifact) => artifact === "findings.md")).toHaveLength(4);
    expect(deps.notifyInfo).toHaveBeenCalledWith(
      ctx,
      "AI review complete: post-fix verification pending",
      expect.stringContaining("findings.md (pre-fix snapshot)"),
    );
    expect(getSavedSession(updates)).toMatchObject({
      currentIteration: 3,
      maxIterations: 3,
      postConsolidationAction: "fix-now",
      artifacts: {
        findingsReport: "findings.md",
      },
    });

  });

  test("rejected findings do not reach review results or auto-fix", async () => {
    const platform = createPlatform();
    const ctx = createContext({
      includeCustom: false,
      selectResponses: ["Quick — fast high-signal review"],
    });
    const updates: ReviewSession[] = [];
    const artifacts: string[] = [];
    const deps = createDependencies({
      updates,
      artifacts,
      validationOutput: {
        status: "passed",
        summary: "Validation complete: 0 confirmed, 1 rejected, 0 uncertain.",
        findings: [
          {
            ...FINDING,
            validation: {
              verdict: "rejected",
              reasoning: "False positive.",
              validatedBy: "validator",
              validatedAt: "2026-04-14T00:00:00.000Z",
            },
          },
        ],
      },
    });

    await runAiReviewSessionForTest(platform, ctx, deps);

    expect(deps.validateReviewFindings).toHaveBeenCalledTimes(1);
    expect(deps.consolidateReviewOutputs).not.toHaveBeenCalled();
    expect(deps.runAutoFix).not.toHaveBeenCalled();
    expect(ctx.ui.select).toHaveBeenCalledTimes(1);
    expect(artifacts).toContain("findings.md");
    expect(getSavedSession(updates)).toMatchObject({
      status: "completed",
      validateFindings: true,
      consolidate: false,
      postConsolidationAction: null,
    });
  });

  test("Document only saves the validated consolidated findings document and skips auto-fix", async () => {
    const platform = createPlatform();
    const ctx = createContext({
      includeCustom: true,
      customResult: "Document only",
      selectResponses: ["Multi-agent — focused specialist agents"],
    });
    const updates: ReviewSession[] = [];
    const artifacts: string[] = [];
    const deps = createDependencies({ level: "multi-agent", updates, artifacts });

    await runAiReviewSessionForTest(platform, ctx, deps);

    expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
    expect(deps.validateReviewFindings).toHaveBeenCalledTimes(1);
    expect(deps.consolidateReviewOutputs).toHaveBeenCalledTimes(1);
    expect(deps.runAutoFix).not.toHaveBeenCalled();
    expect(artifacts).toContain("findings.md");
    expect(getSavedSession(updates) as any).toMatchObject({
      validateFindings: true,
      consolidate: true,
      postConsolidationAction: "document-only",
      artifacts: {
        findingsReport: "findings.md",
      },
    });
  });
  test("multi-agent sessions stay blocked when a specialist agent was blocked upstream", async () => {
    const platform = createPlatform();
    const ctx = createContext({
      includeCustom: true,
      customResult: "Document only",
      selectResponses: ["Multi-agent — focused specialist agents"],
    });
    const updates: ReviewSession[] = [];
    const artifacts: string[] = [];
    const confirmedFinding = {
      ...FINDING,
      validation: {
        verdict: "confirmed" as const,
        reasoning: "Confirmed.",
        validatedBy: "validator",
        validatedAt: "2026-04-14T00:00:00.000Z",
      },
    };
    const deps = createDependencies({
      level: "multi-agent",
      updates,
      artifacts,
      reviewOutput: {
        ...OUTPUT_WITH_FINDINGS,
        status: "blocked",
        summary: "Ran 2 review agents: 1 findings, 1 blocked.",
      },
      validationOutput: {
        status: "failed",
        summary: "Validation complete: 1 confirmed, 0 rejected, 0 uncertain.",
        findings: [confirmedFinding],
      },
      consolidatedOutput: {
        status: "failed",
        summary: "Consolidated to 1 unique finding.",
        findings: [confirmedFinding],
      },
    });

    await runAiReviewSessionForTest(platform, ctx, deps);

    expect(deps.validateReviewFindings).toHaveBeenCalledTimes(1);
    expect(deps.consolidateReviewOutputs).toHaveBeenCalledTimes(1);
    expect(deps.runAutoFix).not.toHaveBeenCalled();
    expect(artifacts).toContain("findings.md");
    expect(getSavedSession(updates)).toMatchObject({
      status: "blocked",
      validateFindings: true,
      consolidate: true,
      postConsolidationAction: "document-only",
    });
  });


  test("Discuss before fixing saves first and hands off with the findings document path", async () => {
    const events: string[] = [];
    const platform = createPlatform(events);
    const ctx = createContext({
      includeCustom: true,
      customResult: "Discuss before fixing",
      selectResponses: ["Quick — fast high-signal review"],
    });
    const updates: ReviewSession[] = [];
    const deps = createDependencies({ events, updates });

    await runAiReviewSessionForTest(platform, ctx, deps);

    expect(deps.validateReviewFindings).toHaveBeenCalledTimes(1);
    expect(deps.runAutoFix).not.toHaveBeenCalled();
    expect(platform.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(platform.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("review-test-session"));
    expect(platform.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("Missing guard"));
    expect(platform.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("findings.md"));
    expect(getSavedSession(updates) as any).toMatchObject({
      postConsolidationAction: "discuss-before-fixing",
      artifacts: {
        findingsReport: "findings.md",
      },
    });

    const saveIndex = events.findIndex((entry) => entry.startsWith("updateReviewSession:review-test-session"));
    const messageIndex = events.findIndex((entry) => entry.startsWith("sendUserMessage:"));
    expect(saveIndex).toBeGreaterThanOrEqual(0);
    expect(messageIndex).toBeGreaterThan(saveIndex);
  });

  test("skips validation and the approval step when there are no findings but still writes findings.md", async () => {
    const platform = createPlatform();
    const ctx = createContext({
      includeCustom: false,
      selectResponses: ["Quick — fast high-signal review"],
    });
    const updates: ReviewSession[] = [];
    const artifacts: string[] = [];
    const deps = createDependencies({ reviewOutput: OUTPUT_WITHOUT_FINDINGS, updates, artifacts });

    await runAiReviewSessionForTest(platform, ctx, deps);

    expect(ctx.ui.select).toHaveBeenCalledTimes(1);
    expect(ctx.ui.custom).toBeUndefined();
    expect(deps.validateReviewFindings).not.toHaveBeenCalled();
    expect(deps.runAutoFix).not.toHaveBeenCalled();
    expect(artifacts).toContain("findings.md");
    expect(getSavedSession(updates) as any).toMatchObject({
      validateFindings: false,
      postConsolidationAction: null,
      artifacts: {
        findingsReport: "findings.md",
      },
    });
  });

  test("shows Review results between Consolidate and Fix findings in the workflow widget", async () => {
    const platform = createPlatform();
    const ctx = createContext({
      includeCustom: false,
      selectResponses: ["Quick — fast high-signal review"],
    });
    const deps = createDependencies({ reviewOutput: OUTPUT_WITHOUT_FINDINGS });

    await runAiReviewSessionForTest(platform, ctx, deps);

    const widgetText = getRenderedWidgetTexts(ctx).find((text) =>
      text.includes("Consolidate") && text.includes("Review results") && text.includes("Fix findings"),
    );
    expect(widgetText).toBeDefined();
    expect((widgetText as string).indexOf("Consolidate")).toBeLessThan((widgetText as string).indexOf("Review results"));
    expect((widgetText as string).indexOf("Review results")).toBeLessThan((widgetText as string).indexOf("Fix findings"));
  });

  test("falls back to select with the findings document path when custom widgets are unavailable", async () => {
    const platform = createPlatform();
    const ctx = createContext({
      includeCustom: false,
      selectResponses: [
        "Quick — fast high-signal review",
        "Document only",
      ],
    });
    const deps = createDependencies();

    await runAiReviewSessionForTest(platform, ctx, deps);

    const reviewResultsPrompt = ctx.ui.select.mock.calls.find((call: any[]) => call[0] === "Review results");
    expect(reviewResultsPrompt).toBeDefined();
    expect(reviewResultsPrompt?.[1]).toEqual([
      "Fix now",
      "Document only",
      "Discuss before fixing",
    ]);
    expect(reviewResultsPrompt?.[2]?.helpText).toContain("findings.md");
  });

  test("explains what the review loop will do before the user accepts it", async () => {
    const platform = createPlatform();
    const ctx = createContext({
      includeCustom: false,
      selectResponses: [
        "Quick — fast high-signal review",
        "Fix now",
        "No",
      ],
    });
    const deps = createDependencies();

    await runAiReviewSessionForTest(platform, ctx, deps);

    const reviewLoopPrompt = ctx.ui.select.mock.calls.find((call: any[]) => call[0] === "Run review loop?");
    expect(reviewLoopPrompt).toBeDefined();
    expect(reviewLoopPrompt?.[2]?.helpText).toContain("re-run the same review after the fixes");
    expect(reviewLoopPrompt?.[2]?.helpText).toContain("validate findings again");
    expect(reviewLoopPrompt?.[2]?.helpText).toContain("refresh the findings.md report");
  });

  test("wraps long review-results lines in the custom TUI instead of truncating them", async () => {
    const platform = createPlatform();
    let renderedLines: string[] = [];
    const ctx = createContext({
      includeCustom: true,
      customResult: "Document only",
      onCustomFactory: (factory) => {
        if (typeof factory !== "function") {
          return;
        }

        const screen = (factory as any)({ requestRender() {} }, null, null, () => {});
        renderedLines = screen.render(40);
      },
      selectResponses: ["Quick — fast high-signal review"],
    });
    const deps = createDependencies({
      reviewOutput: {
        ...OUTPUT_WITH_FINDINGS,
        summary: "This is a deliberately long summary line that should wrap across multiple terminal rows instead of disappearing off the right edge.",
      },
    });

    await runAiReviewSessionForTest(platform, ctx, deps);

    expect(renderedLines.length).toBeGreaterThan(12);
    expect(renderedLines.some((line) => line.includes("findings.md"))).toBeTrue();
    expect(renderedLines.some((line) => line.includes("disappearing off the right edge"))).toBeTrue();
  });
  test("keeps the completed review-loop step focused on iteration progress instead of finding counts", async () => {
    const platform = createPlatform();
    const ctx = createContext({
      includeCustom: false,
      selectResponses: [
        "Quick — fast high-signal review",
        "Fix now",
        "Yes",
      ],
    });
    const deps = createDependencies();

    await runAiReviewSessionForTest(platform, ctx, deps);

    const widgetText = getRenderedWidgetTexts(ctx).find((text) => text.includes("Review loop"));
    expect(widgetText).toBeDefined();
    expect(widgetText as string).toContain("Review loop (iteration 3/3)");
    expect(widgetText as string).not.toContain("Review loop (1 finding(s))");
    expect(widgetText as string).not.toContain("Review loop (3 finding(s))");
  });

});
