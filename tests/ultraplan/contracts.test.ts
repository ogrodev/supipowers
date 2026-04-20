import { describe, expect, test } from "bun:test";
import {
  isUltraPlanAgentSlots,
  isUltraPlanAuthoredArtifact,
  isUltraPlanBlocker,
  isUltraPlanCursor,
  isUltraPlanDomain,
  isUltraPlanDomainReview,
  isUltraPlanIndex,
  isUltraPlanIndexEntry,
  isUltraPlanManifest,
  isUltraPlanProof,
  isUltraPlanScenario,
  isUltraPlanStack,
  isUltraPlanStackReview,
  validateUltraPlanAuthoredArtifact,
} from "../../src/ultraplan/contracts.js";

const proof = {
  type: "test",
  phase: "green",
  recordedAt: "2026-04-19T12:00:00.000Z",
  actor: "frontend-executor",
  evidence: {
    summary: "bun test tests/ultraplan/contracts.test.ts passed",
    command: "bun test tests/ultraplan/contracts.test.ts",
  },
  artifactRef: "artifact://proof-1",
};

const blocker = {
  code: "awaiting-input",
  message: "Waiting for product copy confirmation",
  scope: "session",
  affected: {
    stack: null,
    domainId: null,
    level: null,
    scenarioId: null,
  },
  recoverable: true,
  recoveryMode: "await-user",
  nextAction: "Ask the user for the final copy",
  retryable: false,
  detectedAt: "2026-04-19T12:05:00.000Z",
  details: {
    prompt: "Confirm the final copy for the dashboard header",
  },
};

const scenario = {
  id: "scenario-login-form-renders",
  title: "Login form renders required fields",
  stack: "frontend",
  domainId: "auth",
  level: "unit",
  status: "planned",
  steps: [
    "Write a failing test for the login form fields",
    "Implement the missing inputs",
  ],
  assignedSlots: ["frontend-executor"],
  proofs: [proof],
  dependencies: ["scenario-auth-shell"],
  blocker: blocker,
};

const domain = {
  id: "auth",
  name: "Authentication",
  unit: [scenario],
  integration: [],
  e2e: [],
  review: {
    enabled: true,
    status: "pending",
  },
  progress: {
    total: 1,
    terminal: 0,
    blocked: 0,
  },
};

const agentSlots = {
  executor: {
    slot: "frontend-executor",
    agentType: "built-in",
    agentName: "frontend-executor",
    model: null,
    thinkingLevel: null,
  },
  tester: {
    slot: "frontend-tester",
    agentType: "named",
    agentName: "playwright-red-team",
    model: "claude-sonnet-4.5",
    thinkingLevel: "medium",
  },
  domainReviewEnabled: true,
  stackReviewEnabled: true,
  domainReviewer: {
    slot: "frontend-domain-reviewer",
    agentType: "built-in",
    agentName: "frontend-domain-reviewer",
    model: null,
    thinkingLevel: null,
  },
  stackReviewer: {
    slot: "frontend-stack-reviewer",
    agentType: "built-in",
    agentName: "frontend-stack-reviewer",
    model: null,
    thinkingLevel: null,
  },
};

const stack = {
  stack: "frontend",
  applicability: "applicable",
  domains: [domain],
  status: "ready",
  agentSlots,
  progress: {
    total: 1,
    terminal: 0,
    blocked: 0,
  },
};

const cursor = {
  targetType: "scenario",
  stack: "frontend",
  domainId: "auth",
  level: "unit",
  scenarioId: "scenario-login-form-renders",
  phase: "red",
  status: "planned",
  summary: "frontend / auth / unit / Login form renders required fields",
};

const domainReview = {
  stack: "frontend",
  domainId: "auth",
  reviewerSlot: "frontend-domain-reviewer",
  status: "passed",
  startedAt: "2026-04-19T12:10:00.000Z",
  completedAt: "2026-04-19T12:12:00.000Z",
  summary: "Domain review passed with no findings",
  artifactRef: "artifact://domain-review-auth",
};

const stackReview = {
  stack: "frontend",
  reviewerSlot: "frontend-stack-reviewer",
  status: "passed",
  startedAt: "2026-04-19T12:13:00.000Z",
  completedAt: "2026-04-19T12:15:00.000Z",
  summary: "Stack review passed with no findings",
  artifactRef: "artifact://stack-review-frontend",
};

const authored = {
  sessionId: "up-123",
  title: "Build authentication slice",
  goal: "Deliver the first auth flow across frontend and backend",
  createdAt: "2026-04-19T12:00:00.000Z",
  updatedAt: "2026-04-19T12:00:00.000Z",
  stacks: [stack],
};

const manifest = {
  sessionId: "up-123",
  projectName: "supipowers",
  title: "Build authentication slice",
  authored: {
    json: "/tmp/up-123/authored.json",
    markdown: "/tmp/up-123/authored.md",
  },
  state: "ready",
  cursor,
  lastCompleted: cursor,
  progress: {
    total: 1,
    terminal: 0,
    blocked: 0,
  },
  stacks: [
    {
      stack: "frontend",
      applicability: "applicable",
      progress: {
        total: 1,
        terminal: 0,
        blocked: 0,
      },
      domainCount: 1,
      terminalDomainCount: 0,
    },
  ],
  blocker: blocker,
  reviews: [
    {
      type: "domain",
      stack: "frontend",
      domainId: "auth",
      path: "/tmp/up-123/review/frontend/domains/auth.json",
      status: "passed",
    },
    {
      type: "stack",
      stack: "frontend",
      domainId: null,
      path: "/tmp/up-123/review/frontend/stack.json",
      status: "passed",
    },
  ],
  createdAt: "2026-04-19T12:00:00.000Z",
  updatedAt: "2026-04-19T12:15:00.000Z",
};

const indexEntry = {
  sessionId: "up-123",
  title: "Build authentication slice",
  state: "ready",
  bucket: "pending",
  createdAt: "2026-04-19T12:00:00.000Z",
  updatedAt: "2026-04-19T12:15:00.000Z",
  cursor,
  idleReason: null,
};

const index = {
  sessions: [indexEntry],
};

describe("ultraplan contracts", () => {
  test("accepts valid canonical phase-1 artifacts", () => {
    expect(isUltraPlanProof(proof)).toBe(true);
    expect(isUltraPlanBlocker(blocker)).toBe(true);
    expect(isUltraPlanScenario(scenario)).toBe(true);
    expect(isUltraPlanDomain(domain)).toBe(true);
    expect(isUltraPlanAgentSlots(agentSlots)).toBe(true);
    expect(isUltraPlanStack(stack)).toBe(true);
    expect(isUltraPlanCursor(cursor)).toBe(true);
    expect(isUltraPlanDomainReview(domainReview)).toBe(true);
    expect(isUltraPlanStackReview(stackReview)).toBe(true);
    expect(isUltraPlanAuthoredArtifact(authored)).toBe(true);
    expect(isUltraPlanManifest(manifest)).toBe(true);
    expect(isUltraPlanIndexEntry(indexEntry)).toBe(true);
    expect(isUltraPlanIndex(index)).toBe(true);
  });
  test("rejects terminal scenarios that are missing a phase- and type-matched proof", () => {
    expect(isUltraPlanScenario({ ...scenario, status: "done", proofs: [] })).toBe(false);
    expect(
      isUltraPlanScenario({ ...scenario, status: "review-passed", proofs: [{ ...proof, phase: "green" }] }),
    ).toBe(false);
    expect(
      isUltraPlanScenario({
        ...scenario,
        status: "green-proved",
        proofs: [{ ...proof, type: "artifact" }],
      }),
    ).toBe(false);
    expect(
      isUltraPlanScenario({
        ...scenario,
        status: "review-passed",
        proofs: [{ ...proof, phase: "review", type: "artifact" }],
      }),
    ).toBe(false);

    expect(
      validateUltraPlanAuthoredArtifact({
        ...authored,
        stacks: [
          {
            ...stack,
            domains: [
              {
                ...domain,
                unit: [{ ...scenario, status: "green-proved", proofs: [] }],
              },
            ],
          },
        ],
      }).ok,
    ).toBe(false);
  });

  test("accepts done scenarios backed by prior terminal proofs", () => {
    expect(
      isUltraPlanScenario({
        ...scenario,
        status: "done",
        proofs: [{ ...proof, phase: "green", type: "test" }],
      }),
    ).toBe(true);
    expect(
      isUltraPlanScenario({
        ...scenario,
        status: "done",
        proofs: [{ ...proof, phase: "review", type: "review" }],
      }),
    ).toBe(true);
  });



  test("rejects artifacts missing required fields", () => {
    expect(isUltraPlanProof({ ...proof, recordedAt: undefined })).toBe(false);
    expect(isUltraPlanBlocker({ ...blocker, nextAction: undefined })).toBe(false);
    expect(isUltraPlanScenario({ ...scenario, steps: undefined })).toBe(false);
    expect(isUltraPlanDomain({ ...domain, unit: undefined })).toBe(false);
    expect(isUltraPlanAgentSlots({ ...agentSlots, executor: undefined })).toBe(false);
    expect(isUltraPlanStack({ ...stack, applicability: undefined })).toBe(false);
    expect(isUltraPlanCursor({ ...cursor, phase: undefined })).toBe(false);
    expect(isUltraPlanDomainReview({ ...domainReview, reviewerSlot: undefined })).toBe(false);
    expect(isUltraPlanStackReview({ ...stackReview, summary: undefined })).toBe(false);
    expect(isUltraPlanAuthoredArtifact({ ...authored, stacks: undefined })).toBe(false);
    expect(isUltraPlanManifest({ ...manifest, authored: undefined })).toBe(false);
    expect(isUltraPlanIndexEntry({ ...indexEntry, bucket: undefined })).toBe(false);
    expect(isUltraPlanIndex({ sessions: [{ ...indexEntry, state: undefined }] })).toBe(false);
  });
});
