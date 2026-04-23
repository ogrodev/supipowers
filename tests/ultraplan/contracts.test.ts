import { describe, expect, test } from "bun:test";
import {
  ULTRAPLAN_AGENT_SLOT_NAMES,
  ULTRAPLAN_REVIEWER_SLOT_NAMES,
  isResolvedUltraPlanCatalog,
  isResolvedUltraPlanSlotBinding,
  isUltraPlanAgentDefinitionFrontmatter,
  isUltraPlanAgentSlots,
  isUltraPlanAuthoredArtifact,
  isUltraPlanBatchActiveRunLease,
  isUltraPlanBatchJournalEvent,
  isUltraPlanBatchNode,
  isUltraPlanBatchWave,
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
  validateUltraPlanBatchRun,
} from "../../src/ultraplan/contracts.js";

import {
  makeUltraPlanBatchActiveRunLease,
  makeUltraPlanBatchJournalEvent,
  makeUltraPlanBatchNode,
  makeUltraPlanBatchRun,
  makeUltraPlanBatchWave,
} from "./fixtures.js";
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
const agentDefinitionFrontmatter = {
  name: "integration-breaker",
  description: "Adversarial integration and regression tester",
  supportedSlots: ["backend-tester", "infrastructure-tester"],
  model: "anthropic/claude-sonnet-4-20250514",
  thinkingLevel: "low",
  focus: "integration failures, regression pressure",
};

const resolvedSlotBinding = {
  slot: "backend-tester",
  agentType: "named",
  agentName: "integration-breaker",
  model: "anthropic/claude-sonnet-4-20250514",
  thinkingLevel: "low",
  selectionSource: "project",
  definitionSource: "global",
  modelSource: "project",
  thinkingLevelSource: "global",
  definitionPath: "/tmp/global-agents/integration-breaker.md",
};

const resolvedCatalog = {
  slots: Object.fromEntries(
    ULTRAPLAN_AGENT_SLOT_NAMES.map((slot) => [slot, slot === "backend-tester" ? resolvedSlotBinding : null]),
  ),
  reviewGates: {
    "backend-domain-reviewer": { enabled: true },
  },
};

const batchNode = makeUltraPlanBatchNode();

const batchWave = makeUltraPlanBatchWave();

const batchRun = makeUltraPlanBatchRun({
  waves: [batchWave],
  nodes: [batchNode],
});

const activeRunLease = makeUltraPlanBatchActiveRunLease();

const batchJournalEvent = makeUltraPlanBatchJournalEvent();




describe("ultraplan contracts", () => {
  test("derives reviewer slots from the canonical slot list", () => {
    const expectedReviewerSlots = ULTRAPLAN_AGENT_SLOT_NAMES.filter(
      (slot): slot is (typeof ULTRAPLAN_REVIEWER_SLOT_NAMES)[number] =>
        slot.endsWith("-domain-reviewer") || slot.endsWith("-stack-reviewer"),
    );

    expect(ULTRAPLAN_REVIEWER_SLOT_NAMES).toEqual(expectedReviewerSlots);
  });

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



  test("accepts agent definition frontmatter with optional model defaults", () => {
    expect(isUltraPlanAgentDefinitionFrontmatter(agentDefinitionFrontmatter)).toBe(true);
    expect(
      isUltraPlanAgentDefinitionFrontmatter({
        ...agentDefinitionFrontmatter,
        supportedSlots: ["backend-unknown"],
      }),
    ).toBe(false);
  });

  test("requires truthful resolved binding provenance fields", () => {
    expect(isResolvedUltraPlanSlotBinding(resolvedSlotBinding)).toBe(true);
    expect(
      isResolvedUltraPlanSlotBinding({
        ...resolvedSlotBinding,
        selectionSource: "global",
      }),
    ).toBe(false);
  });

  test("rejects resolved catalogs whose review gates target executor slots", () => {
    expect(isResolvedUltraPlanCatalog(resolvedCatalog)).toBe(true);
    expect(
      isResolvedUltraPlanCatalog({
        ...resolvedCatalog,
        reviewGates: {
          "frontend-executor": { enabled: true },
        },
      }),
    ).toBe(false);
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


describe("ultraplan batch contracts", () => {
  test("accepts canonical batch run artifacts", () => {
    expect(isUltraPlanBatchNode(batchNode)).toBe(true);
    expect(isUltraPlanBatchWave(batchWave)).toBe(true);
    expect(validateUltraPlanBatchRun(batchRun).ok).toBe(true);
    expect(isUltraPlanBatchActiveRunLease(activeRunLease)).toBe(true);
    expect(isUltraPlanBatchJournalEvent(batchJournalEvent)).toBe(true);
  });

  test("requires currentBaseHead and batchResumeRequestedAt in batch runs", () => {
    const { currentBaseHead: _currentBaseHead, ...missingCurrentBaseHead } = batchRun;
    const { batchResumeRequestedAt: _batchResumeRequestedAt, ...missingBatchResumeRequestedAt } = batchRun;

    expect(validateUltraPlanBatchRun(missingCurrentBaseHead).ok).toBe(false);
    expect(validateUltraPlanBatchRun(missingBatchResumeRequestedAt).ok).toBe(false);
  });

  test("rejects semantically invalid batch graphs", () => {
    expect(validateUltraPlanBatchRun({
      ...batchRun,
      waves: [{ waveIndex: 0, sessionIds: ["missing-session"] }],
    }).ok).toBe(false);

    expect(validateUltraPlanBatchRun({
      ...batchRun,
      nodes: [{ ...batchNode, dependencies: ["missing-session"] }],
    }).ok).toBe(false);
  });

  test("rejects invalid active-run lease shapes", () => {
    expect(isUltraPlanBatchActiveRunLease({ ...activeRunLease, ownerSessionId: undefined })).toBe(false);
    expect(isUltraPlanBatchActiveRunLease({ ...activeRunLease, leaseExpiresAt: undefined })).toBe(false);
    expect(isUltraPlanBatchActiveRunLease({ ...activeRunLease, ownerSessionId: null })).toBe(false);
    expect(isUltraPlanBatchActiveRunLease({ ...activeRunLease, leaseExpiresAt: null })).toBe(false);
    expect(isUltraPlanBatchActiveRunLease({ ...activeRunLease, leaseAcquiredAt: "not-a-date" })).toBe(false);
  });
});


// ---------------------------------------------------------------------------
// Slice 2 runtime contracts: hook observation, attempt record, runtime tracker,
// reducer action, mutation plan, and migration record.
// ---------------------------------------------------------------------------

import {
  isUltraPlanHookObservation,
  isUltraPlanLaunchContext,
  isUltraPlanAttemptRecord,
  isUltraPlanReducerAction,
  isUltraPlanMutationPlan,
  isUltraPlanRuntimeTracker,
  isUltraPlanSessionMigrationRecord,
  validateUltraPlanRuntimeTracker,
  validateUltraPlanSessionMigrationRecord,
} from "../../src/ultraplan/contracts.js";

const launchContext = {
  attemptId: "att-001",
  attemptKey: "frontend/auth/unit/scenario-login-form-renders/red",
  sourceAgent: "sub-agent",
  launchedAt: "2026-04-19T12:00:00.000Z",
};

const observationTarget = {
  targetType: "scenario",
  stack: "frontend",
  domainId: "auth",
  level: "unit",
  scenarioId: "scenario-login-form-renders",
  phase: "red",
  resolvedSlot: "frontend-tester",
};

const hookObservation = {
  sessionId: "up-123",
  hookEvent: "tool_result",
  actorKind: "slot",
  attemptId: "att-001",
  attemptKey: "frontend/auth/unit/scenario-login-form-renders/red",
  sourceAgent: "sub-agent",
  occurredAt: "2026-04-19T12:00:01.000Z",
  causationId: "tool-call-42",
  fingerprint: "fp-tool-result-1",
  target: observationTarget,
  correlationFailure: null,
  payloadSummary: "bun test failed in expected red phase",
};

const proofCandidate = {
  phase: "red",
  type: "test",
  target: {
    targetType: "scenario",
    stack: "frontend",
    domainId: "auth",
    level: "unit",
    scenarioId: "scenario-login-form-renders",
  },
  evidence: { summary: "red-phase failure proof", command: "bun test" },
  artifactRef: null,
  observationFingerprint: "fp-tool-result-1",
  fingerprint: "proof-fp-1",
};

const blockerCandidate = {
  blocker: {
    code: "proof-missing",
    message: "Expected red-phase proof; received none",
    scope: "scenario",
    affected: {
      stack: "frontend",
      domainId: "auth",
      level: "unit",
      scenarioId: "scenario-login-form-renders",
    },
    recoverable: true,
    recoveryMode: "retry",
    nextAction: "Re-run the red-phase test",
    retryable: true,
    detectedAt: "2026-04-19T12:01:00.000Z",
  },
  observationFingerprint: "fp-tool-result-1",
};

const cursorRuntime = {
  targetType: "scenario",
  stack: "frontend",
  domainId: "auth",
  level: "unit",
  scenarioId: "scenario-login-form-renders",
  phase: "red",
  status: "red-running",
  summary: "frontend / auth / unit / Login form renders required fields",
};

const attemptRecord = {
  attemptId: "att-001",
  attemptKey: "frontend/auth/unit/scenario-login-form-renders/red",
  launchContext,
  cursorSnapshot: cursorRuntime,
  observations: [hookObservation],
  proofCandidates: [proofCandidate],
  blockerCandidates: [],
  outcome: null,
  startedAt: "2026-04-19T12:00:00.000Z",
  finalizedAt: null,
};

const noopMutationPlan = {
  kind: "noop",
  rationale: "Replay of already-applied observation",
  appendObservationFingerprint: null,
  scenarioStatusUpdate: null,
  reviewStatusUpdate: null,
  blockerUpdate: null,
  cursorUpdate: null,
  sessionStateUpdate: null,
  trackerAttemptFinalization: null,
  recomputeProgress: false,
  repairActions: [],
  notes: [],
};

const advanceMutationPlan = {
  ...noopMutationPlan,
  kind: "advance",
  rationale: "Red-phase proof matched cursor",
  appendObservationFingerprint: "fp-tool-result-1",
  scenarioStatusUpdate: {
    stack: "frontend",
    domainId: "auth",
    level: "unit",
    scenarioId: "scenario-login-form-renders",
    nextStatus: "red-proved",
    appendProof: {
      type: "test",
      phase: "red",
      recordedAt: "2026-04-19T12:00:01.000Z",
      actor: "frontend-tester",
      evidence: { summary: "red passed as failed" },
      artifactRef: "artifact://red-proof",
    },
  },
  cursorUpdate: { ...cursorRuntime, status: "red-proved", phase: "green" },
  trackerAttemptFinalization: {
    attemptId: "att-001",
    outcome: "advanced",
    finalizedAt: "2026-04-19T12:00:02.000Z",
  },
  recomputeProgress: true,
};

const blockingMutationPlan = {
  ...noopMutationPlan,
  kind: "block",
  rationale: "Conflicting evidence: proof and blocker on same finalization",
  appendObservationFingerprint: "fp-tool-result-1",
  blockerUpdate: {
    scope: "scenario",
    nextValue: blockerCandidate.blocker,
    clearedByObservationFingerprint: null,
  },
  trackerAttemptFinalization: {
    attemptId: "att-001",
    outcome: "blocked",
    finalizedAt: "2026-04-19T12:00:02.000Z",
  },
};

const pendingMutation = {
  attemptId: "att-001",
  mutationPlan: advanceMutationPlan,
  expectedManifestFingerprint: "sha256:abcdef",
  stagedAt: "2026-04-19T12:00:01.500Z",
};

const runtimeTracker = {
  version: 1,
  sessionId: "up-123",
  activeAttempt: attemptRecord,
  finalizedAttempts: [],
  appliedFingerprints: [],
  pendingMutation: null,
  updatedAt: "2026-04-19T12:00:01.000Z",
};

const reducerAction = {
  kind: "observation_staged",
  observation: hookObservation,
};

const migrationRecord = {
  migratedAt: "2026-04-20T12:00:00.000Z",
  legacyPath: "/abs/repo/.omp/supipowers/ultraplans/up-123",
  fingerprintBefore: "sha256:before",
  fingerprintAfter: "sha256:after",
  legacyRenamedTo: "/abs/repo/.omp/supipowers/ultraplans/up-123.migrated-2026-04-20T12-00-00Z",
  kind: "copied",
};

describe("ultraplan runtime contracts", () => {
  test("accepts canonical hook observations and launch contexts", () => {
    expect(isUltraPlanLaunchContext(launchContext)).toBe(true);
    expect(isUltraPlanHookObservation(hookObservation)).toBe(true);
  });

  test("hook observations may be session-scope (no attempt key) but must keep correlationFailure null", () => {
    const sessionScope = {
      ...hookObservation,
      hookEvent: "session_start",
      actorKind: "main-orchestrator",
      attemptId: null,
      attemptKey: null,
      target: null,
    };
    expect(isUltraPlanHookObservation(sessionScope)).toBe(true);
  });

  test("hook observations carry a correlation failure when ambiguity exists", () => {
    const failure = {
      ...hookObservation,
      attemptId: null,
      attemptKey: null,
      target: null,
      correlationFailure: { reason: "slot-backed event without active attempt" },
    };
    expect(isUltraPlanHookObservation(failure)).toBe(true);
  });

  test("rejects hook observations missing required fields", () => {
    expect(isUltraPlanHookObservation({ ...hookObservation, sessionId: undefined })).toBe(false);
    expect(isUltraPlanHookObservation({ ...hookObservation, fingerprint: undefined })).toBe(false);
    expect(isUltraPlanHookObservation({ ...hookObservation, hookEvent: "unknown_event" })).toBe(false);
    expect(isUltraPlanHookObservation({ ...hookObservation, actorKind: "executor" })).toBe(false);
  });

  test("accepts canonical attempt records with active observations and proof candidates", () => {
    expect(isUltraPlanAttemptRecord(attemptRecord)).toBe(true);
    expect(isUltraPlanAttemptRecord({ ...attemptRecord, outcome: "interrupted", finalizedAt: "2026-04-19T13:00:00.000Z" })).toBe(true);
  });

  test("rejects attempt records with mismatched outcome/finalizedAt pairing", () => {
    // outcome present but finalizedAt missing
    expect(isUltraPlanAttemptRecord({ ...attemptRecord, outcome: "advanced", finalizedAt: null })).toBe(false);
    // finalizedAt present but outcome missing
    expect(isUltraPlanAttemptRecord({ ...attemptRecord, outcome: null, finalizedAt: "2026-04-19T13:00:00.000Z" })).toBe(false);
  });

  test("runtime tracker round-trips with active attempts, finalized ledger, and dedupe set", () => {
    expect(isUltraPlanRuntimeTracker(runtimeTracker)).toBe(true);

    const withFinalized = {
      ...runtimeTracker,
      activeAttempt: null,
      finalizedAttempts: [{ ...attemptRecord, outcome: "advanced", finalizedAt: "2026-04-19T12:00:02.000Z" }],
      appliedFingerprints: ["fp-tool-result-1"],
    };
    expect(isUltraPlanRuntimeTracker(withFinalized)).toBe(true);
    expect(validateUltraPlanRuntimeTracker(withFinalized).ok).toBe(true);
  });

  test("runtime tracker accepts a pendingMutation and exposes its mutation plan", () => {
    const staged = { ...runtimeTracker, pendingMutation };
    const validation = validateUltraPlanRuntimeTracker(staged);
    expect(validation.ok).toBe(true);
    if (validation.ok) {
      expect(validation.value.pendingMutation?.mutationPlan.kind).toBe("advance");
    }
  });

  test("runtime tracker rejects an unknown version", () => {
    expect(isUltraPlanRuntimeTracker({ ...runtimeTracker, version: 99 })).toBe(false);
  });

  test("reducer actions are a discriminated union", () => {
    expect(isUltraPlanReducerAction({ kind: "session_started", observation: hookObservation, nowIso: "2026-04-19T12:00:00.000Z" })).toBe(true);
    expect(isUltraPlanReducerAction({ kind: "attempt_started", observation: hookObservation, launchContext })).toBe(true);
    expect(isUltraPlanReducerAction(reducerAction)).toBe(true);
    expect(isUltraPlanReducerAction({ kind: "attempt_finalized", observation: hookObservation, nowIso: "2026-04-19T12:00:02.000Z" })).toBe(true);
    expect(isUltraPlanReducerAction({ kind: "session_shutdown", observation: hookObservation, nowIso: "2026-04-19T13:00:00.000Z" })).toBe(true);
    expect(isUltraPlanReducerAction({ kind: "repair_applied", nowIso: "2026-04-19T13:00:00.000Z", details: { reason: "stale cursor", actions: [{ op: "recompute-cursor", reason: "stale" }] } })).toBe(true);
    expect(isUltraPlanReducerAction({ kind: "unknown", observation: hookObservation })).toBe(false);
  });

  test("mutation plans accept noop, advance, and block shapes", () => {
    expect(isUltraPlanMutationPlan(noopMutationPlan)).toBe(true);
    expect(isUltraPlanMutationPlan(advanceMutationPlan)).toBe(true);
    expect(isUltraPlanMutationPlan(blockingMutationPlan)).toBe(true);
  });

  test("mutation plans reject conflicting proof+blocker within one plan", () => {
    const conflicting = {
      ...advanceMutationPlan,
      // Same plan tries to both advance with proof AND set a new blocker.
      blockerUpdate: blockingMutationPlan.blockerUpdate,
    };
    expect(isUltraPlanMutationPlan(conflicting)).toBe(false);
  });

  test("mutation plans reject terminal scenario advancement without proof", () => {
    const advanceWithoutProof = {
      ...advanceMutationPlan,
      scenarioStatusUpdate: {
        ...advanceMutationPlan.scenarioStatusUpdate!,
        appendProof: undefined,
      },
    };
    expect(isUltraPlanMutationPlan(advanceWithoutProof)).toBe(false);
  });

  test("session migration records validate and require absolute legacyPath + non-empty fingerprints", () => {
    expect(isUltraPlanSessionMigrationRecord(migrationRecord)).toBe(true);
    expect(isUltraPlanSessionMigrationRecord({ ...migrationRecord, kind: "reconciled-no-op" })).toBe(true);
    expect(isUltraPlanSessionMigrationRecord({ ...migrationRecord, legacyRenamedTo: null })).toBe(true);

    expect(validateUltraPlanSessionMigrationRecord({ ...migrationRecord, legacyPath: "relative/path" }).ok).toBe(false);
    expect(validateUltraPlanSessionMigrationRecord({ ...migrationRecord, fingerprintBefore: "" }).ok).toBe(false);
    expect(validateUltraPlanSessionMigrationRecord({ ...migrationRecord, fingerprintAfter: "" }).ok).toBe(false);
    expect(validateUltraPlanSessionMigrationRecord({ ...migrationRecord, kind: "unknown" }).ok).toBe(false);
  });
});
