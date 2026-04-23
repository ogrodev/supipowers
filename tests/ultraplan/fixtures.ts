import * as fs from "node:fs";
import * as path from "node:path";
import type { PlatformPaths } from "../../src/platform/types.js";
import type { UltraPlanExecutionTarget } from "../../src/ultraplan/execution/policy.js";
import type {
  UltraPlanRuntimeSignalBlockInput,
  UltraPlanRuntimeSignalProofInput,
} from "../../src/ultraplan/execution/runtime-tools.js";
import type { ActiveUltraPlanExecution } from "../../src/ultraplan/runtime/active-execution.js";
import type {
  ResolvedUltraPlanCatalog,
  ResolvedUltraPlanSlotBinding,
  UltraPlanAgentSlotName,
  UltraPlanAttemptRecord,
  UltraPlanAuthoredArtifact,
  UltraPlanBatchActiveRunLease,
  UltraPlanBatchJournalEvent,
  UltraPlanBatchNode,
  UltraPlanBatchRun,
  UltraPlanBatchWave,
  UltraPlanHookObservation,
  UltraPlanLaunchContext,
  UltraPlanManifest,
  UltraPlanMutationPlan,
  UltraPlanPendingMutation,
  UltraPlanProof,
  UltraPlanReviewStatus,
  UltraPlanReviewerSlotName,
  UltraPlanRuntimeTracker,
  UltraPlanScenario,
  UltraPlanScenarioLevel,
  UltraPlanScenarioStatus,
  UltraPlanSessionMigrationRecord,
  UltraPlanStack,
} from "../../src/types.js";

export function createTestPaths(rootDir: string): PlatformPaths {
  return {
    dotDir: ".omp",
    dotDirDisplay: ".omp",
    project: (cwd: string, ...segments: string[]) => path.join(cwd, ".omp", "supipowers", ...segments),
    global: (...segments: string[]) => path.join(rootDir, "global-config", ".omp", "supipowers", ...segments),
    agent: (...segments: string[]) => path.join(rootDir, "agent", ...segments),
  };
}

export function createTestRepo(rootDir: string, name = "supipowers"): { repoRoot: string; subdir: string } {
  const repoRoot = path.join(rootDir, name);
  const subdir = path.join(repoRoot, "src", "features");
  fs.mkdirSync(subdir, { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "package.json"), JSON.stringify({ name }), "utf8");
  return { repoRoot, subdir };
}

export function makeUltraPlanProof(
  phase: "green" | "review" | "complete",
  overrides: Partial<UltraPlanProof> = {},
): UltraPlanProof {
  const type = phase === "review" ? "review" : phase === "complete" ? "artifact" : "test";

  return {
    type,
    phase,
    recordedAt: "2026-04-19T12:00:00.000Z",
    actor: "frontend-executor",
    evidence: {
      summary: `${phase} proof`,
    },
    artifactRef: `artifact://${phase}-proof`,
    ...overrides,
  };
}

function buildDefaultProofs(status: UltraPlanScenarioStatus): UltraPlanProof[] {
  switch (status) {
    case "green-proved":
      return [makeUltraPlanProof("green")];
    case "review-passed":
      return [makeUltraPlanProof("review")];
    case "done":
      return [makeUltraPlanProof("complete")];
    default:
      return [];
  }
}

export function makeUltraPlanScenario(
  id: string,
  title: string,
  status: UltraPlanScenarioStatus,
  level: UltraPlanScenarioLevel = "unit",
  overrides: Partial<UltraPlanScenario> = {},
): UltraPlanScenario {
  return {
    id,
    title,
    stack: "frontend",
    domainId: "auth",
    level,
    status,
    steps: ["do the work"],
    assignedSlots: ["frontend-executor"],
    proofs: overrides.proofs ?? buildDefaultProofs(status),
    ...overrides,
  };
}

export function makeUltraPlanStack(overrides: Partial<UltraPlanStack> = {}): UltraPlanStack {
  return {
    stack: "frontend",
    applicability: "applicable",
    domains: [
      {
        id: "auth",
        name: "Authentication",
        unit: [
          makeUltraPlanScenario("scenario-a", "First scenario", "planned"),
          makeUltraPlanScenario("scenario-b", "Second scenario", "planned"),
        ],
        integration: [],
        e2e: [],
        review: {
          enabled: true,
          status: "pending",
        },
        progress: {
          total: 2,
          terminal: 0,
          blocked: 0,
        },
      },
    ],
    status: "ready",
    agentSlots: {
      executor: {
        slot: "frontend-executor",
        agentType: "built-in",
        agentName: "frontend-executor",
        model: null,
        thinkingLevel: null,
      },
      tester: {
        slot: "frontend-tester",
        agentType: "built-in",
        agentName: "frontend-tester",
        model: null,
        thinkingLevel: null,
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
    },
    progress: {
      total: 2,
      terminal: 0,
      blocked: 0,
    },
    ...overrides,
  };
}

export function makeUltraPlanAuthored(overrides: Partial<UltraPlanAuthoredArtifact> = {}): UltraPlanAuthoredArtifact {
  return {
    sessionId: "up-123",
    title: "Auth slice",
    goal: "Ship authentication",
    createdAt: "2026-04-19T12:00:00.000Z",
    updatedAt: "2026-04-19T12:00:00.000Z",
    stacks: [makeUltraPlanStack()],
    ...overrides,
  };
}

export function makeUltraPlanManifest(overrides: Partial<UltraPlanManifest> = {}): UltraPlanManifest {
  return {
    sessionId: "up-123",
    projectName: "supipowers",
    title: "Auth slice",
    authored: {
      json: "authored.json",
      markdown: "authored.md",
    },
    state: "ready",
    cursor: null,
    lastCompleted: null,
    progress: {
      total: 2,
      terminal: 0,
      blocked: 0,
    },
    stacks: [
      {
        stack: "frontend",
        applicability: "applicable",
        progress: {
          total: 2,
          terminal: 0,
          blocked: 0,
        },
        domainCount: 1,
        terminalDomainCount: 0,
      },
    ],
    blocker: null,
    reviews: [],
    createdAt: "2026-04-19T12:00:00.000Z",
    updatedAt: "2026-04-19T12:00:00.000Z",
    ...overrides,
  };
}


export function makeUltraPlanHookObservation(
  overrides: Partial<UltraPlanHookObservation> = {},
): UltraPlanHookObservation {
  return {
    sessionId: "up-123",
    hookEvent: "tool_result",
    actorKind: "slot",
    attemptId: "att-001",
    attemptKey: "frontend/auth/unit/scenario-login-form-renders/red",
    sourceAgent: "sub-agent",
    occurredAt: "2026-04-19T12:00:01.000Z",
    causationId: "tool-call-1",
    fingerprint: "fp-observation-1",
    target: {
      targetType: "scenario",
      stack: "frontend",
      domainId: "auth",
      level: "unit",
      scenarioId: "scenario-login-form-renders",
      phase: "red",
      resolvedSlot: "frontend-tester",
    },
    correlationFailure: null,
    payloadSummary: "red-phase tool result",
    ...overrides,
  };
}

export function makeUltraPlanLaunchContext(
  overrides: Partial<UltraPlanLaunchContext> = {},
): UltraPlanLaunchContext {
  return {
    attemptId: "att-001",
    attemptKey: "frontend/auth/unit/scenario-login-form-renders/red",
    sourceAgent: "sub-agent",
    launchedAt: "2026-04-19T12:00:00.000Z",
    ...overrides,
  };
}

export function makeUltraPlanAttemptRecord(
  overrides: Partial<UltraPlanAttemptRecord> = {},
): UltraPlanAttemptRecord {
  return {
    attemptId: "att-001",
    attemptKey: "frontend/auth/unit/scenario-login-form-renders/red",
    launchContext: makeUltraPlanLaunchContext(),
    cursorSnapshot: null,
    observations: [],
    proofCandidates: [],
    blockerCandidates: [],
    outcome: null,
    startedAt: "2026-04-19T12:00:00.000Z",
    finalizedAt: null,
    ...overrides,
  };
}

export function makeUltraPlanRuntimeTracker(
  overrides: Partial<UltraPlanRuntimeTracker> = {},
): UltraPlanRuntimeTracker {
  return {
    version: 1,
    sessionId: "up-123",
    activeAttempt: null,
    finalizedAttempts: [],
    appliedFingerprints: [],
    pendingMutation: null,
    updatedAt: "2026-04-19T12:00:00.000Z",
    ...overrides,
  };
}

export function makeUltraPlanSessionMigrationRecord(
  overrides: Partial<UltraPlanSessionMigrationRecord> = {},
): UltraPlanSessionMigrationRecord {
  return {
    migratedAt: "2026-04-20T12:00:00.000Z",
    legacyPath: "/tmp/legacy-repo/.omp/supipowers/ultraplans/up-123",
    fingerprintBefore: "sha256:before",
    fingerprintAfter: "sha256:after",
    legacyRenamedTo: "/tmp/legacy-repo/.omp/supipowers/ultraplans/up-123.migrated-2026-04-20T12-00-00Z",
    kind: "copied",
    ...overrides,
  };
}

/**
 * Seed a legacy repo-local ultraplan session directory under `<repoRoot>/.omp/supipowers/ultraplans/<sessionId>/`.
 * Returns the absolute path to the seeded session directory.
 */
export function seedLegacyRepoLocalSession(
  repoRoot: string,
  sessionId: string,
  contents: {
    authored: UltraPlanAuthoredArtifact;
    manifest: UltraPlanManifest;
    extras?: Record<string, string>;
  },
): string {
  const legacyDir = path.join(repoRoot, ".omp", "supipowers", "ultraplans", sessionId);
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, "authored.json"), `${JSON.stringify(contents.authored, null, 2)}\n`);
  fs.writeFileSync(path.join(legacyDir, "manifest.json"), `${JSON.stringify(contents.manifest, null, 2)}\n`);
  for (const [name, body] of Object.entries(contents.extras ?? {})) {
    const target = path.join(legacyDir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }
  return legacyDir;
}

const ULTRAPLAN_ALL_SLOT_NAMES: readonly UltraPlanAgentSlotName[] = [
  "frontend-executor",
  "frontend-tester",
  "frontend-domain-reviewer",
  "frontend-stack-reviewer",
  "backend-executor",
  "backend-tester",
  "backend-domain-reviewer",
  "backend-stack-reviewer",
  "infrastructure-executor",
  "infrastructure-tester",
  "infrastructure-domain-reviewer",
  "infrastructure-stack-reviewer",
];

export function makeCatalogFixture(opts: {
  reviewGates?: Partial<Record<UltraPlanReviewerSlotName, { enabled: boolean }>>;
  slotNulls?: UltraPlanAgentSlotName[];
} = {}): ResolvedUltraPlanCatalog {
  const nulls = new Set(opts.slotNulls ?? []);
  const slots = {} as ResolvedUltraPlanCatalog["slots"];
  for (const slot of ULTRAPLAN_ALL_SLOT_NAMES) {
    slots[slot] = nulls.has(slot) ? null : ({
      slot,
      agentType: "built-in",
      agentName: slot,
      model: null,
      thinkingLevel: null,
      selectionSource: "default",
      definitionSource: "built-in",
      modelSource: "unset",
      thinkingLevelSource: "unset",
      definitionPath: null,
    } satisfies ResolvedUltraPlanSlotBinding);
  }
  return { slots, reviewGates: opts.reviewGates ?? {} };
}

export function makeUltraPlanDomainReviewMap(
  entries: Partial<Record<UltraPlanStack["stack"], Record<string, UltraPlanReviewStatus>>> = {},
): ReadonlyMap<UltraPlanStack["stack"], ReadonlyMap<string, UltraPlanReviewStatus>> {
  return new Map(
    Object.entries(entries).map(([stack, domainStatuses]) => [stack as UltraPlanStack["stack"], new Map(Object.entries(domainStatuses ?? {}))]),
  );
}

export function makeUltraPlanStackReviewMap(
  entries: Partial<Record<UltraPlanStack["stack"], UltraPlanReviewStatus>> = {},
): ReadonlyMap<UltraPlanStack["stack"], UltraPlanReviewStatus> {
  return new Map(Object.entries(entries) as [UltraPlanStack["stack"], UltraPlanReviewStatus][]);
}

export function makeUltraPlanExecutionTarget(
  overrides: Partial<UltraPlanExecutionTarget> = {},
): UltraPlanExecutionTarget {
  return {
    targetType: "scenario",
    stack: "frontend",
    domainId: "auth",
    level: "unit",
    scenarioId: "scenario-login-form-renders",
    phase: "red",
    status: "planned",
    summary: "frontend / auth / unit / Login form renders",
    requiredSlot: "frontend-executor",
    reviewArtifactPath: null,
    ...overrides,
  };
}

export function makeActiveUltraPlanExecution(
  overrides: Partial<ActiveUltraPlanExecution> = {},
): ActiveUltraPlanExecution {
  return {
    sessionId: "up-123",
    cwd: "/repo",
    target: makeUltraPlanExecutionTarget(),
    launchContext: makeUltraPlanLaunchContext(),
    slotBinding: makeCatalogFixture().slots["frontend-executor"],
    ...overrides,
  };
}

export function makeUltraPlanMutationPlan(
  overrides: Partial<UltraPlanMutationPlan> = {},
): UltraPlanMutationPlan {
  return {
    kind: "noop",
    rationale: "no-op fixture",
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
    ...overrides,
  };
}

export function makeUltraPlanPendingMutation(
  overrides: Partial<UltraPlanPendingMutation> = {},
): UltraPlanPendingMutation {
  return {
    attemptId: "att-001",
    mutationPlan: makeUltraPlanMutationPlan(),
    expectedManifestFingerprint: "sha256:manifest-before",
    stagedAt: "2026-04-19T12:00:00.000Z",
    ...overrides,
  };
}

export function makeUltraPlanSignalProofInput(
  overrides: Partial<UltraPlanRuntimeSignalProofInput> = {},
): UltraPlanRuntimeSignalProofInput {
  return {
    kind: "proof",
    summary: "Tests passed",
    details: { command: "bun test" },
    ...overrides,
  };
}

export function makeUltraPlanSignalBlockInput(
  overrides: Partial<UltraPlanRuntimeSignalBlockInput> = {},
): UltraPlanRuntimeSignalBlockInput {
  return {
    kind: "block",
    code: "blocked",
    summary: "Execution is blocked",
    details: { reason: "fixture" },
    ...overrides,
  };
}

export function makeUltraPlanSignalAwaitUserInput(
  overrides: Partial<UltraPlanRuntimeSignalBlockInput> = {},
): UltraPlanRuntimeSignalBlockInput {
  return makeUltraPlanSignalBlockInput({
    kind: "await-user",
    code: "await-user",
    summary: "Awaiting user input",
    ...overrides,
  });
}


export function makeUltraPlanBatchWave(overrides: Partial<UltraPlanBatchWave> = {}): UltraPlanBatchWave {
  return {
    waveIndex: 0,
    sessionIds: ["up-123"],
    ...overrides,
  };
}

export function makeUltraPlanBatchNode(overrides: Partial<UltraPlanBatchNode> = {}): UltraPlanBatchNode {
  return {
    nodeId: "node-up-123",
    sessionId: "up-123",
    title: "Auth slice",
    waveIndex: 0,
    dependencies: [],
    state: "pending",
    blockerKind: null,
    blockerSummary: null,
    resumeRequestedAt: null,
    branchName: null,
    worktreePath: null,
    updatedAt: "2026-04-21T12:00:00.000Z",
    ...overrides,
  };
}

export function makeUltraPlanBatchRun(overrides: Partial<UltraPlanBatchRun> = {}): UltraPlanBatchRun {
  return {
    runId: "batch-123",
    projectRoot: "/tmp/supipowers",
    baseBranch: "main",
    baseHead: "sha-base",
    currentBaseHead: "sha-base",
    createdAt: "2026-04-21T12:00:00.000Z",
    updatedAt: "2026-04-21T12:00:00.000Z",
    state: "paused",
    maxParallelism: 2,
    batchBlockerCode: null,
    batchBlockerSummary: null,
    batchResumeRequestedAt: null,
    supervisorWorktreePath: null,
    waves: overrides.waves ?? [makeUltraPlanBatchWave()],
    nodes: overrides.nodes ?? [makeUltraPlanBatchNode()],
    ...overrides,
  };
}

export function makeUltraPlanBatchRunWithNodes(
  nodes: UltraPlanBatchNode[],
  overrides: Partial<UltraPlanBatchRun> = {},
): UltraPlanBatchRun {
  const waves = [...new Set(nodes.map((node) => node.waveIndex))]
    .sort((left, right) => left - right)
    .map((waveIndex) => makeUltraPlanBatchWave({
      waveIndex,
      sessionIds: nodes.filter((node) => node.waveIndex === waveIndex).map((node) => node.sessionId),
    }));

  return makeUltraPlanBatchRun({
    nodes,
    waves,
    ...overrides,
  });
}

export function makeUltraPlanBatchActiveRunLease(
  overrides: Partial<UltraPlanBatchActiveRunLease> = {},
): UltraPlanBatchActiveRunLease {
  return {
    runId: "batch-123",
    ownerSessionId: "main-session-1",
    leaseAcquiredAt: "2026-04-21T12:00:00.000Z",
    leaseExpiresAt: "2026-04-21T12:05:00.000Z",
    updatedAt: "2026-04-21T12:00:00.000Z",
    ...overrides,
  };
}

export function makeUltraPlanBatchJournalEvent(
  overrides: Partial<UltraPlanBatchJournalEvent> = {},
): UltraPlanBatchJournalEvent {
  return {
    runId: "batch-123",
    sessionId: "up-123",
    type: "run-created",
    recordedAt: "2026-04-21T12:00:00.000Z",
    summary: "Created batch run batch-123",
    ...overrides,
  };
}