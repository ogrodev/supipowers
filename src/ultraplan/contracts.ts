import { z } from "zod/v4";
import type { ZodType } from "zod/v4";
import type {
  ResolvedUltraPlanCatalog,
  ResolvedUltraPlanSlotBinding,
  ThinkingLevel,
  UltraPlanActorKind,
  UltraPlanAgentDefinitionFrontmatter,
  UltraPlanAgentSlotName,
  UltraPlanAgentSlots,
  UltraPlanAttemptOutcome,
  UltraPlanAttemptRecord,
  UltraPlanAuthoringFinding,
  UltraPlanAuthoringFindingSeverity,
  UltraPlanAuthoringFindingSource,
  UltraPlanAuthoringFindingsArtifact,
  UltraPlanAuthoringPipelineEvent,
  UltraPlanAuthoringPipelineMode,
  UltraPlanAuthoringSlotName,
  UltraPlanAuthoringStage,
  UltraPlanAuthoringStageStatus,
  UltraPlanAuthoringState,
  UltraPlanAuthoringArtifactRefs,
  UltraPlanAuthoredArtifact,
  UltraPlanBatchActiveRunLease,
  UltraPlanBatchBlockerCode,
  UltraPlanBatchJournalEvent,
  UltraPlanBatchJournalEventType,
  UltraPlanBatchNode,
  UltraPlanBatchNodeBlockerKind,
  UltraPlanBatchNodeState,
  UltraPlanBatchRun,
  UltraPlanBatchRunState,
  UltraPlanBatchWave,
  UltraPlanBlocker,
  UltraPlanBlockerCandidate,
  UltraPlanBlockerScope,
  UltraPlanCursor,
  UltraPlanDomain,
  UltraPlanDomainReview,
  UltraPlanHookEventName,
  UltraPlanHookObservation,
  UltraPlanIndex,
  UltraPlanIndexEntry,
  UltraPlanLaunchContext,
  UltraPlanManifest,
  UltraPlanMutationKind,
  UltraPlanMutationPlan,
  UltraPlanPendingMutation,
  UltraPlanProof,
  UltraPlanProofCandidate,
  UltraPlanReducerAction,
  UltraPlanRepairAction,
  UltraPlanReviewerSlotName,
  UltraPlanRuntimeTracker,
  UltraPlanScenario,
  UltraPlanSessionMigrationKind,
  UltraPlanSessionMigrationRecord,
  UltraPlanSourceAgent,
  UltraPlanStack,
  UltraPlanStackReview,
} from "../types.js";
import { getUltraPlanBatchGraphErrors } from "./batch/planner.js";
import { checkSchema, collectSchemaValidationErrors, parseSchema } from "../ai/schema-validation.js";

export type {
  ResolvedUltraPlanCatalog,
  ResolvedUltraPlanSlotBinding,
  UltraPlanActorKind,
  UltraPlanAgentDefinitionFrontmatter,
  UltraPlanAgentSlots,
  UltraPlanAttemptOutcome,
  UltraPlanAttemptRecord,
  UltraPlanAuthoringFinding,
  UltraPlanAuthoringFindingSeverity,
  UltraPlanAuthoringFindingSource,
  UltraPlanAuthoringFindingsArtifact,
  UltraPlanAuthoringPipelineEvent,
  UltraPlanAuthoringPipelineMode,
  UltraPlanAuthoringSlotName,
  UltraPlanAuthoringStage,
  UltraPlanAuthoringStageStatus,
  UltraPlanAuthoringState,
  UltraPlanAuthoringArtifactRefs,
  UltraPlanAuthoredArtifact,
  UltraPlanBatchActiveRunLease,
  UltraPlanBatchBlockerCode,
  UltraPlanBatchJournalEvent,
  UltraPlanBatchJournalEventType,
  UltraPlanBatchNode,
  UltraPlanBatchNodeBlockerKind,
  UltraPlanBatchNodeState,
  UltraPlanBatchRun,
  UltraPlanBatchRunState,
  UltraPlanBatchWave,
  UltraPlanBlocker,
  UltraPlanBlockerCandidate,
  UltraPlanBlockerScope,
  UltraPlanCursor,
  UltraPlanDomain,
  UltraPlanDomainReview,
  UltraPlanHookEventName,
  UltraPlanHookObservation,
  UltraPlanIndex,
  UltraPlanIndexEntry,
  UltraPlanLaunchContext,
  UltraPlanManifest,
  UltraPlanMutationKind,
  UltraPlanMutationPlan,
  UltraPlanPendingMutation,
  UltraPlanProof,
  UltraPlanProofCandidate,
  UltraPlanReducerAction,
  UltraPlanRepairAction,
  UltraPlanReviewerSlotName,
  UltraPlanRuntimeTracker,
  UltraPlanScenario,
  UltraPlanSessionMigrationKind,
  UltraPlanSessionMigrationRecord,
  UltraPlanSourceAgent,
  UltraPlanStack,
  UltraPlanStackReview,
} from "../types.js";

export const ULTRAPLAN_STACKS = ["frontend", "backend", "infrastructure"] as const;
export const ULTRAPLAN_LEVELS = ["unit", "integration", "e2e"] as const;
export const ULTRAPLAN_APPLICABILITY = ["applicable", "not-applicable"] as const;
export const ULTRAPLAN_SESSION_STATES = ["ready", "running", "blocked", "awaiting-user", "complete", "discarded"] as const;
export const ULTRAPLAN_SESSION_BUCKETS = ["pending", "ongoing", "idle", "done"] as const;
export const ULTRAPLAN_SCENARIO_STATUSES = [
  "planned",
  "red-running",
  "red-proved",
  "green-running",
  "green-proved",
  "in-review",
  "review-passed",
  "blocked",
  "done",
] as const;
export const ULTRAPLAN_REVIEW_STATUSES = ["pending", "running", "passed", "failed", "blocked"] as const;
export const ULTRAPLAN_EXECUTION_PHASES = ["red", "green", "review", "waiting", "complete"] as const;
export const ULTRAPLAN_CURSOR_TARGETS = ["scenario", "domain-review", "stack-review", "session"] as const;
export const ULTRAPLAN_AGENT_TYPES = ["built-in", "named"] as const;
export const ULTRAPLAN_PROOF_TYPES = ["test", "command", "review", "artifact"] as const;
export const ULTRAPLAN_BLOCKER_SCOPES = ["session", "stack", "domain", "scenario"] as const;
export const ULTRAPLAN_RECOVERY_MODES = ["retry", "await-user", "manual"] as const;
export const ULTRAPLAN_AGENT_SLOT_NAMES = [
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
] as const;
export const ULTRAPLAN_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const satisfies ThinkingLevel[];
function isUltraPlanReviewerSlotName(slot: UltraPlanAgentSlotName): slot is UltraPlanReviewerSlotName {
  return slot.endsWith("-domain-reviewer") || slot.endsWith("-stack-reviewer");
}
export const ULTRAPLAN_REVIEWER_SLOT_NAMES: readonly UltraPlanReviewerSlotName[] = ULTRAPLAN_AGENT_SLOT_NAMES.filter(
  isUltraPlanReviewerSlotName,
);
export const ULTRAPLAN_SELECTION_SOURCES = ["default", "project"] as const;
export const ULTRAPLAN_DEFINITION_SOURCES = ["built-in", "global"] as const;
export const ULTRAPLAN_RESOLVED_VALUE_SOURCES = [
  "project",
  "global",
  "built-in",
  "unset",
] as const;

// --- Authoring pipeline constants -------------------------------------------------

export const ULTRAPLAN_AUTHORING_STAGES = [
  "intake",
  "scout",
  "discover",
  "research",
  "synthesize",
  "review",
  "approve",
] as const satisfies readonly UltraPlanAuthoringStage[];

export const ULTRAPLAN_AUTHORING_STAGE_STATUSES = [
  "pending",
  "running",
  "blocked",
  "awaiting-user",
  "done",
] as const satisfies readonly UltraPlanAuthoringStageStatus[];

export const ULTRAPLAN_AUTHORING_SLOT_NAMES = [
  "intake",
  "scout",
  "discoverer",
  "researcher",
  "planner",
  "structure-checker",
  "scope-checker",
  "tdd-checker",
] as const satisfies readonly UltraPlanAuthoringSlotName[];

export const ULTRAPLAN_AUTHORING_PIPELINE_MODES = [
  "single-shot",
  "multi-stage",
] as const satisfies readonly UltraPlanAuthoringPipelineMode[];

export const ULTRAPLAN_AUTHORING_FINDING_SEVERITIES = [
  "BLOCKER",
  "WARNING",
] as const satisfies readonly UltraPlanAuthoringFindingSeverity[];

export const ULTRAPLAN_AUTHORING_FINDING_SOURCES = [
  "structure-checker",
  "scope-checker",
  "tdd-checker",
] as const satisfies readonly UltraPlanAuthoringFindingSource[];


function keyedObject(keys: readonly string[], valueSchema: ZodType) {
  return z.object(
    Object.fromEntries(keys.map((key) => [key, valueSchema])) as Record<string, ZodType>,
  ).strict();
}

function sparseKeyedObject(keys: readonly string[], valueSchema: ZodType) {
  return keyedObject(keys, valueSchema).partial();
}



function literalUnion<const TValue extends readonly string[]>(values: TValue) {
  return z.enum([...values] as unknown as [TValue[number], ...TValue[number][]]);
}

export const UltraPlanProgressSummarySchema = z.object(
  {
    total: z.number().min(0),
    terminal: z.number().min(0),
    blocked: z.number().min(0),
  },
).strict();

export const UltraPlanAffectedUnitRefSchema = z.object(
  {
    stack: literalUnion(ULTRAPLAN_STACKS).nullable(),
    domainId: z.string().min(1).nullable(),
    level: literalUnion(ULTRAPLAN_LEVELS).nullable(),
    scenarioId: z.string().min(1).nullable(),
  },
).strict();

export const UltraPlanProofEvidenceSchema = z.object(
  {
    summary: z.string().min(1),
    command: z.string().min(1).optional(),
    outputRef: z.string().min(1).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  },
).strict();

export const UltraPlanProofSchema = z.object(
  {
    type: literalUnion(ULTRAPLAN_PROOF_TYPES),
    phase: literalUnion(ULTRAPLAN_EXECUTION_PHASES),
    recordedAt: z.string().min(1),
    actor: z.string().min(1),
    evidence: UltraPlanProofEvidenceSchema,
    artifactRef: z.string().min(1),
  },
).strict();

export const UltraPlanBlockerSchema = z.object(
  {
    code: z.string().min(1),
    message: z.string().min(1),
    scope: literalUnion(ULTRAPLAN_BLOCKER_SCOPES),
    affected: UltraPlanAffectedUnitRefSchema,
    recoverable: z.boolean(),
    recoveryMode: literalUnion(ULTRAPLAN_RECOVERY_MODES),
    nextAction: z.string().min(1),
    retryable: z.boolean(),
    detectedAt: z.string().min(1),
    details: z.record(z.string(), z.unknown()).optional(),
  },
).strict();

export const UltraPlanAgentBindingSchema = z.object(
  {
    slot: literalUnion(ULTRAPLAN_AGENT_SLOT_NAMES),
    agentType: literalUnion(ULTRAPLAN_AGENT_TYPES),
    agentName: z.string().min(1),
    model: z.string().min(1).nullable(),
    thinkingLevel: literalUnion(ULTRAPLAN_THINKING_LEVELS).nullable(),
  },
).strict();

export const UltraPlanAgentSlotsSchema = z.object(
  {
    executor: UltraPlanAgentBindingSchema,
    tester: UltraPlanAgentBindingSchema,
    domainReviewEnabled: z.boolean(),
    stackReviewEnabled: z.boolean(),
    domainReviewer: UltraPlanAgentBindingSchema.optional(),
    stackReviewer: UltraPlanAgentBindingSchema.optional(),
  },
).strict();

export const UltraPlanSlotOverrideSchema = z.object(
  {
    agentName: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    thinkingLevel: literalUnion(ULTRAPLAN_THINKING_LEVELS).optional(),
  },
).strict();

export const UltraPlanReviewGatePolicySchema = z.object(
  {
    enabled: z.boolean(),
  },
).strict();

export const UltraPlanConfigSchema = z.object(
  {
    slots: sparseKeyedObject(ULTRAPLAN_AGENT_SLOT_NAMES, UltraPlanSlotOverrideSchema).optional(),
    reviewGates: sparseKeyedObject(
      ULTRAPLAN_REVIEWER_SLOT_NAMES,
      UltraPlanReviewGatePolicySchema,
    ).optional(),
  },
).strict();

export const UltraPlanAgentDefinitionFrontmatterSchema = z.object(
  {
    name: z.string().min(1),
    description: z.string().min(1),
    supportedSlots: z.array(literalUnion(ULTRAPLAN_AGENT_SLOT_NAMES)).min(1),
    model: z.string().min(1).optional(),
    thinkingLevel: literalUnion(ULTRAPLAN_THINKING_LEVELS).optional(),
    focus: z.string().min(1).optional(),
  },
).strict();

export const ResolvedUltraPlanSlotBindingSchema = z.object(
  {
    slot: literalUnion(ULTRAPLAN_AGENT_SLOT_NAMES),
    agentType: literalUnion(ULTRAPLAN_AGENT_TYPES),
    agentName: z.string().min(1),
    model: z.string().min(1).nullable(),
    thinkingLevel: literalUnion(ULTRAPLAN_THINKING_LEVELS).nullable(),
    selectionSource: literalUnion(ULTRAPLAN_SELECTION_SOURCES),
    definitionSource: literalUnion(ULTRAPLAN_DEFINITION_SOURCES),
    modelSource: literalUnion(ULTRAPLAN_RESOLVED_VALUE_SOURCES),
    thinkingLevelSource: literalUnion(ULTRAPLAN_RESOLVED_VALUE_SOURCES),
    definitionPath: z.string().min(1).nullable(),
  },
).strict();

export const ResolvedUltraPlanCatalogSchema = z.object(
  {
    slots: keyedObject(
      ULTRAPLAN_AGENT_SLOT_NAMES,
      ResolvedUltraPlanSlotBindingSchema.nullable(),
    ),
    reviewGates: sparseKeyedObject(
      ULTRAPLAN_REVIEWER_SLOT_NAMES,
      UltraPlanReviewGatePolicySchema,
    ),
  },
).strict();


const ULTRAPLAN_NON_TERMINAL_SCENARIO_STATUSES = [
  "planned",
  "red-running",
  "red-proved",
  "green-running",
  "in-review",
  "blocked",
] as const;

const ULTRAPLAN_TERMINAL_SCENARIO_STATUSES = ["green-proved", "review-passed", "done"] as const;

const UltraPlanScenarioSharedShape = {
  id: z.string().min(1),
  title: z.string().min(1),
  stack: literalUnion(ULTRAPLAN_STACKS),
  domainId: z.string().min(1),
  level: literalUnion(ULTRAPLAN_LEVELS),
  steps: z.array(z.string().min(1)),
  assignedSlots: z.array(literalUnion(ULTRAPLAN_AGENT_SLOT_NAMES)),
  dependencies: z.array(z.string().min(1)).optional(),
  blocker: UltraPlanBlockerSchema.nullable().optional(),
};

export const UltraPlanScenarioSchema = z.union([
  z.object(
    {
      ...UltraPlanScenarioSharedShape,
      status: literalUnion(ULTRAPLAN_NON_TERMINAL_SCENARIO_STATUSES),
      proofs: z.array(UltraPlanProofSchema),
    },
  ).strict(),
  z.object(
    {
      ...UltraPlanScenarioSharedShape,
      status: literalUnion(ULTRAPLAN_TERMINAL_SCENARIO_STATUSES),
      proofs: z.array(UltraPlanProofSchema).min(1),
    },
  ).strict(),
]);

export const UltraPlanDomainReviewGateSchema = z.object(
  {
    enabled: z.boolean(),
    status: literalUnion(ULTRAPLAN_REVIEW_STATUSES),
  },
).strict();

export const UltraPlanDomainSchema = z.object(
  {
    id: z.string().min(1),
    name: z.string().min(1),
    unit: z.array(UltraPlanScenarioSchema),
    integration: z.array(UltraPlanScenarioSchema),
    e2e: z.array(UltraPlanScenarioSchema),
    review: UltraPlanDomainReviewGateSchema,
    progress: UltraPlanProgressSummarySchema,
  },
).strict();

export const UltraPlanStackSchema = z.object(
  {
    stack: literalUnion(ULTRAPLAN_STACKS),
    applicability: literalUnion(ULTRAPLAN_APPLICABILITY),
    domains: z.array(UltraPlanDomainSchema),
    status: literalUnion(ULTRAPLAN_SESSION_STATES),
    agentSlots: UltraPlanAgentSlotsSchema,
    progress: UltraPlanProgressSummarySchema,
  },
).strict();

export const UltraPlanCursorSchema = z.object(
  {
    targetType: literalUnion(ULTRAPLAN_CURSOR_TARGETS),
    stack: literalUnion(ULTRAPLAN_STACKS).nullable(),
    domainId: z.string().min(1).nullable(),
    level: literalUnion(ULTRAPLAN_LEVELS).nullable(),
    scenarioId: z.string().min(1).nullable(),
    phase: literalUnion(ULTRAPLAN_EXECUTION_PHASES),
    status: literalUnion([
      ...ULTRAPLAN_SCENARIO_STATUSES,
      ...ULTRAPLAN_REVIEW_STATUSES,
      ...ULTRAPLAN_SESSION_STATES,
    ] as const),
    summary: z.string().min(1),
  },
).strict();

export const UltraPlanDomainReviewSchema = z.object(
  {
    stack: literalUnion(ULTRAPLAN_STACKS),
    domainId: z.string().min(1),
    reviewerSlot: literalUnion(ULTRAPLAN_AGENT_SLOT_NAMES),
    status: literalUnion(ULTRAPLAN_REVIEW_STATUSES),
    startedAt: z.string().min(1),
    completedAt: z.string().min(1).optional(),
    summary: z.string().min(1),
    artifactRef: z.string().min(1),
  },
).strict();

export const UltraPlanStackReviewSchema = z.object(
  {
    stack: literalUnion(ULTRAPLAN_STACKS),
    reviewerSlot: literalUnion(ULTRAPLAN_AGENT_SLOT_NAMES),
    status: literalUnion(ULTRAPLAN_REVIEW_STATUSES),
    startedAt: z.string().min(1),
    completedAt: z.string().min(1).optional(),
    summary: z.string().min(1),
    artifactRef: z.string().min(1),
  },
).strict();

export const UltraPlanAuthoredArtifactSchema = z.object(
  {
    sessionId: z.string().min(1),
    title: z.string().min(1),
    goal: z.string().min(1),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    stacks: z.array(UltraPlanStackSchema),
  },
).strict();

export const UltraPlanManifestAuthoredRefsSchema = z.object(
  {
    json: z.string().min(1),
    markdown: z.string().min(1).optional(),
  },
).strict();

export const UltraPlanManifestStackSummarySchema = z.object(
  {
    stack: literalUnion(ULTRAPLAN_STACKS),
    applicability: literalUnion(ULTRAPLAN_APPLICABILITY),
    progress: UltraPlanProgressSummarySchema,
    domainCount: z.number().min(0),
    terminalDomainCount: z.number().min(0),
  },
).strict();

export const UltraPlanManifestReviewReferenceSchema = z.object(
  {
    type: literalUnion(["domain", "stack"] as const),
    stack: literalUnion(ULTRAPLAN_STACKS),
    domainId: z.string().min(1).nullable(),
    path: z.string().min(1),
    status: literalUnion(ULTRAPLAN_REVIEW_STATUSES),
  },
).strict();

// --- Authoring pipeline schemas ---------------------------------------------------

export const UltraPlanAuthoringFindingSchema = z.object(
  {
    id: z.string().min(1),
    severity: literalUnion(ULTRAPLAN_AUTHORING_FINDING_SEVERITIES),
    source: literalUnion(ULTRAPLAN_AUTHORING_FINDING_SOURCES),
    target: z.object(
      {
        stack: literalUnion(ULTRAPLAN_STACKS).nullable(),
        domainId: z.string().min(1).nullable(),
        scenarioId: z.string().min(1).nullable(),
      },
    ).strict(),
    message: z.string().min(1),
    recommendation: z.string().min(1),
    recordedAt: z.string().min(1),
  },
).strict();

export const UltraPlanAuthoringFindingsArtifactSchema = z.object(
  {
    iteration: z.number().int().min(1),
    draftRef: z.string().min(1),
    recordedAt: z.string().min(1),
    findings: z.array(UltraPlanAuthoringFindingSchema),
  },
).strict();

export const UltraPlanAuthoringResearchRefSchema = z.object(
  {
    stack: literalUnion(ULTRAPLAN_STACKS),
    path: z.string().min(1),
  },
).strict();

export const UltraPlanAuthoringArtifactRefsSchema = z.object(
  {
    intake: z.string().min(1).optional(),
    scout: z.string().min(1).optional(),
    discuss: z.string().min(1).optional(),
    deferredIdeas: z.string().min(1).optional(),
    research: z.array(UltraPlanAuthoringResearchRefSchema).optional(),
    researchSummary: z.string().min(1).optional(),
    draft: z.string().min(1).optional(),
    draftMarkdown: z.string().min(1).optional(),
    findings: z.string().min(1).optional(),
  },
).strict();

export const UltraPlanAuthoringStateSchema = z.object(
  {
    pipeline: literalUnion(ULTRAPLAN_AUTHORING_PIPELINE_MODES),
    stage: literalUnion(ULTRAPLAN_AUTHORING_STAGES),
    stageStatus: literalUnion(ULTRAPLAN_AUTHORING_STAGE_STATUSES),
    iteration: z.number().int().min(1),
    stallReentryCount: z.number().int().min(0),
    artifacts: UltraPlanAuthoringArtifactRefsSchema,
    blocker: UltraPlanBlockerSchema.nullable(),
    startedAt: z.string().min(1),
    updatedAt: z.string().min(1),
  },
).strict();

export const UltraPlanAuthoringPipelineEventSchema = z.object(
  {
    recordedAt: z.string().min(1),
    stage: literalUnion(ULTRAPLAN_AUTHORING_STAGES),
    stageStatus: literalUnion(ULTRAPLAN_AUTHORING_STAGE_STATUSES),
    iteration: z.number().int().min(1),
    summary: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  },
).strict();


export const UltraPlanManifestSchema = z.object(
  {
    sessionId: z.string().min(1),
    projectName: z.string().min(1),
    title: z.string().min(1),
    authored: UltraPlanManifestAuthoredRefsSchema,
    state: literalUnion(ULTRAPLAN_SESSION_STATES),
    cursor: UltraPlanCursorSchema.nullable(),
    lastCompleted: UltraPlanCursorSchema.nullable(),
    progress: UltraPlanProgressSummarySchema,
    stacks: z.array(UltraPlanManifestStackSummarySchema),
    blocker: UltraPlanBlockerSchema.nullable(),
    reviews: z.array(UltraPlanManifestReviewReferenceSchema),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    authoring: UltraPlanAuthoringStateSchema.optional(),
  },
).strict();

export const UltraPlanIndexEntrySchema = z.object(
  {
    sessionId: z.string().min(1),
    title: z.string().min(1),
    state: literalUnion(ULTRAPLAN_SESSION_STATES),
    bucket: literalUnion(ULTRAPLAN_SESSION_BUCKETS),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    cursor: UltraPlanCursorSchema.nullable(),
    idleReason: z.string().min(1).nullable(),
    authoringStage: literalUnion(ULTRAPLAN_AUTHORING_STAGES).nullable().optional(),
  },
).strict();

export const UltraPlanIndexSchema = z.object(
  {
    sessions: z.array(UltraPlanIndexEntrySchema),
  },
).strict();

type UltraPlanTerminalProofRequirement = {
  phase: UltraPlanProof["phase"];
  types: readonly UltraPlanProof["type"][];
};

function getRequiredUltraPlanTerminalProofRequirements(
  status: UltraPlanScenario["status"],
): readonly UltraPlanTerminalProofRequirement[] | null {
  switch (status) {
    case "green-proved":
      return [{ phase: "green", types: ["test", "command"] }];
    case "review-passed":
      return [{ phase: "review", types: ["review"] }];
    case "done":
      return [
        { phase: "complete", types: ["artifact", "command", "test"] },
        { phase: "review", types: ["review"] },
        { phase: "green", types: ["test", "command"] },
      ];
    default:
      return null;
  }
}

function formatUltraPlanRequiredProofTypes(types: readonly UltraPlanProof["type"][]): string {
  return types.length === 1
    ? `"${types[0]}"`
    : types.map((type) => `"${type}"`).join(" or ");
}

function formatUltraPlanTerminalProofRequirements(
  requirements: readonly UltraPlanTerminalProofRequirement[],
): string {
  return requirements
    .map((requirement) => `a "${requirement.phase}" proof of type ${formatUltraPlanRequiredProofTypes(requirement.types)}`)
    .join(" or ");
}

export function hasRequiredUltraPlanScenarioProof(scenario: UltraPlanScenario): boolean {
  const requirements = getRequiredUltraPlanTerminalProofRequirements(scenario.status);
  return requirements === null
    || requirements.some((requirement) =>
      scenario.proofs.some((proof) => proof.phase === requirement.phase && requirement.types.includes(proof.type))
    );
}

function collectUltraPlanScenarioProofErrors(
  errors: string[],
  level: UltraPlanScenario["level"],
  scenarios: UltraPlanScenario[],
): void {
  for (const scenario of scenarios) {
    const requirements = getRequiredUltraPlanTerminalProofRequirements(scenario.status);
    if (!requirements || hasRequiredUltraPlanScenarioProof(scenario)) {
      continue;
    }

    errors.push(
      `/stacks/${scenario.stack}/domains/${scenario.domainId}/${level}/${scenario.id} terminal scenario "${scenario.id}" with status "${scenario.status}" requires at least one terminal proof: ${formatUltraPlanTerminalProofRequirements(requirements)}`,
    );
  }
}

function getUltraPlanAuthoredArtifactSemanticErrors(authored: UltraPlanAuthoredArtifact): string[] {
  const errors: string[] = [];

  for (const stack of authored.stacks) {
    for (const domain of stack.domains) {
      collectUltraPlanScenarioProofErrors(errors, "unit", domain.unit);
      collectUltraPlanScenarioProofErrors(errors, "integration", domain.integration);
      collectUltraPlanScenarioProofErrors(errors, "e2e", domain.e2e);
    }
  }

  return errors;
}


export function getUltraPlanSchemaErrors(schema: ZodType, value: unknown): string[] {
  return collectSchemaValidationErrors(schema, value).map((error) => `${error.path === "(root)" ? "/" : error.path} ${error.message}`);
}

function buildValidationResult<T>(schema: ZodType<T>, value: unknown):
  | { ok: true; value: T }
  | { ok: false; errors: string[] } {
  const result = parseSchema<T>(schema, value);
  if (result.success) {
    return { ok: true, value: result.data };
  }

  return {
    ok: false,
    errors: result.errors.map((error) => `${error.path === "(root)" ? "/" : error.path} ${error.message}`),
  };
}

export function validateUltraPlanIndex(value: unknown) {
  return buildValidationResult<UltraPlanIndex>(UltraPlanIndexSchema, value);
}

export function validateUltraPlanManifest(value: unknown) {
  return buildValidationResult<UltraPlanManifest>(UltraPlanManifestSchema, value);
}

export function validateUltraPlanAuthoringState(value: unknown) {
  return buildValidationResult<UltraPlanAuthoringState>(UltraPlanAuthoringStateSchema, value);
}

export function validateUltraPlanAuthoringFindingsArtifact(value: unknown) {
  return buildValidationResult<UltraPlanAuthoringFindingsArtifact>(
    UltraPlanAuthoringFindingsArtifactSchema,
    value,
  );
}

export function validateUltraPlanAuthoringPipelineEvent(value: unknown) {
  return buildValidationResult<UltraPlanAuthoringPipelineEvent>(
    UltraPlanAuthoringPipelineEventSchema,
    value,
  );
}

export function validateUltraPlanAuthoredArtifact(value: unknown) {
  const validation = buildValidationResult<UltraPlanAuthoredArtifact>(UltraPlanAuthoredArtifactSchema, value);
  if (!validation.ok) {
    return validation;
  }

  const semanticErrors = getUltraPlanAuthoredArtifactSemanticErrors(validation.value);
  if (semanticErrors.length > 0) {
    return { ok: false, errors: semanticErrors } as const;
  }

  return validation;
}

export function isUltraPlanAgentDefinitionFrontmatter(
  value: unknown,
 ): value is UltraPlanAgentDefinitionFrontmatter {
  return checkSchema(UltraPlanAgentDefinitionFrontmatterSchema, value);
}

export function isResolvedUltraPlanSlotBinding(value: unknown): value is ResolvedUltraPlanSlotBinding {
  return checkSchema(ResolvedUltraPlanSlotBindingSchema, value);
}

export function isResolvedUltraPlanCatalog(value: unknown): value is ResolvedUltraPlanCatalog {
  return checkSchema(ResolvedUltraPlanCatalogSchema, value);
}


export function isUltraPlanProof(value: unknown): value is UltraPlanProof {
  return checkSchema(UltraPlanProofSchema, value);
}

export function isUltraPlanBlocker(value: unknown): value is UltraPlanBlocker {
  return checkSchema(UltraPlanBlockerSchema, value);
}

export function isUltraPlanScenario(value: unknown): value is UltraPlanScenario {
  return checkSchema(UltraPlanScenarioSchema, value)
    && hasRequiredUltraPlanScenarioProof(value as UltraPlanScenario);
}

export function isUltraPlanDomain(value: unknown): value is UltraPlanDomain {
  return checkSchema(UltraPlanDomainSchema, value);
}

export function isUltraPlanAgentSlots(value: unknown): value is UltraPlanAgentSlots {
  return checkSchema(UltraPlanAgentSlotsSchema, value);
}

export function isUltraPlanStack(value: unknown): value is UltraPlanStack {
  return checkSchema(UltraPlanStackSchema, value);
}

export function isUltraPlanCursor(value: unknown): value is UltraPlanCursor {
  return checkSchema(UltraPlanCursorSchema, value);
}

export function isUltraPlanDomainReview(value: unknown): value is UltraPlanDomainReview {
  return checkSchema(UltraPlanDomainReviewSchema, value);
}

export function isUltraPlanStackReview(value: unknown): value is UltraPlanStackReview {
  return checkSchema(UltraPlanStackReviewSchema, value);
}

export function isUltraPlanAuthoredArtifact(value: unknown): value is UltraPlanAuthoredArtifact {
  return validateUltraPlanAuthoredArtifact(value).ok;
}

export function isUltraPlanManifest(value: unknown): value is UltraPlanManifest {
  return checkSchema(UltraPlanManifestSchema, value);
}

export function isUltraPlanIndexEntry(value: unknown): value is UltraPlanIndexEntry {
  return checkSchema(UltraPlanIndexEntrySchema, value);
}

export function isUltraPlanIndex(value: unknown): value is UltraPlanIndex {
  return checkSchema(UltraPlanIndexSchema, value);
}


// ---------------------------------------------------------------------------
// Slice 2 runtime contracts: hook observations, attempts, tracker, reducer,
// mutation plan, migration record.
// ---------------------------------------------------------------------------

export const ULTRAPLAN_HOOK_EVENT_NAMES = [
  "session_start",
  "before_agent_start",
  "tool_call",
  "tool_result",
  "agent_end",
  "session_shutdown",
] as const;

export const ULTRAPLAN_ACTOR_KINDS = ["slot", "main-orchestrator"] as const;
export const ULTRAPLAN_SOURCE_AGENTS = ["main", "sub-agent"] as const;
export const ULTRAPLAN_ATTEMPT_OUTCOMES = ["advanced", "blocked", "interrupted", "noop"] as const;
export const ULTRAPLAN_MUTATION_KINDS = [
  "noop",
  "start-attempt",
  "stage-observation",
  "advance",
  "block",
  "interrupt",
  "repair",
  "complete",
] as const;
export const ULTRAPLAN_MIGRATION_KINDS = ["copied", "reconciled-no-op"] as const;
export const ULTRAPLAN_RUNTIME_BLOCKER_CODES = [
  "correlation-ambiguous",
  "proof-missing",
  "proof-invalid",
  "conflicting-evidence",
  "interrupted-attempt",
  "persistence-failure",
  "unsafe-repair-required",
  "migration-unsafe",
  "migration-conflict",
] as const;

export const UltraPlanLaunchContextSchema = z.object(
  {
    attemptId: z.string().min(1),
    attemptKey: z.string().min(1),
    sourceAgent: literalUnion(ULTRAPLAN_SOURCE_AGENTS),
    launchedAt: z.string().min(1),
  },
).strict();

export const UltraPlanObservationTargetSchema = z.object(
  {
    targetType: literalUnion(ULTRAPLAN_CURSOR_TARGETS),
    stack: literalUnion(ULTRAPLAN_STACKS).nullable(),
    domainId: z.string().min(1).nullable(),
    level: literalUnion(ULTRAPLAN_LEVELS).nullable(),
    scenarioId: z.string().min(1).nullable(),
    phase: literalUnion(ULTRAPLAN_EXECUTION_PHASES),
    resolvedSlot: z.string().min(1).nullable(),
  },
).strict();

export const UltraPlanObservationCorrelationFailureSchema = z.object(
  {
    reason: z.string().min(1),
    details: z.record(z.string(), z.unknown()).optional(),
  },
).strict();

export const UltraPlanHookObservationSchema = z.object(
  {
    sessionId: z.string().min(1),
    hookEvent: literalUnion(ULTRAPLAN_HOOK_EVENT_NAMES),
    actorKind: literalUnion(ULTRAPLAN_ACTOR_KINDS),
    attemptId: z.string().min(1).nullable(),
    attemptKey: z.string().min(1).nullable(),
    sourceAgent: literalUnion(ULTRAPLAN_SOURCE_AGENTS),
    occurredAt: z.string().min(1),
    causationId: z.string().min(1).nullable(),
    fingerprint: z.string().min(1),
    target: UltraPlanObservationTargetSchema.nullable(),
    correlationFailure: UltraPlanObservationCorrelationFailureSchema.nullable(),
    payloadSummary: z.string(),
  },
).strict();

export const UltraPlanProofCandidateTargetSchema = z.object(
  {
    targetType: literalUnion(ULTRAPLAN_CURSOR_TARGETS),
    stack: literalUnion(ULTRAPLAN_STACKS).nullable(),
    domainId: z.string().min(1).nullable(),
    level: literalUnion(ULTRAPLAN_LEVELS).nullable(),
    scenarioId: z.string().min(1).nullable(),
  },
).strict();

export const UltraPlanProofCandidateSchema = z.object(
  {
    phase: literalUnion(ULTRAPLAN_EXECUTION_PHASES),
    type: literalUnion(ULTRAPLAN_PROOF_TYPES),
    target: UltraPlanProofCandidateTargetSchema,
    evidence: UltraPlanProofEvidenceSchema,
    artifactRef: z.string().min(1).nullable(),
    observationFingerprint: z.string().min(1),
    fingerprint: z.string().min(1),
  },
).strict();

export const UltraPlanBlockerCandidateSchema = z.object(
  {
    blocker: UltraPlanBlockerSchema,
    observationFingerprint: z.string().min(1),
  },
).strict();

export const UltraPlanAttemptRecordSchema = z.object(
  {
    attemptId: z.string().min(1),
    attemptKey: z.string().min(1),
    launchContext: UltraPlanLaunchContextSchema,
    cursorSnapshot: UltraPlanCursorSchema.nullable(),
    observations: z.array(UltraPlanHookObservationSchema),
    proofCandidates: z.array(UltraPlanProofCandidateSchema),
    blockerCandidates: z.array(UltraPlanBlockerCandidateSchema),
    outcome: literalUnion(ULTRAPLAN_ATTEMPT_OUTCOMES).nullable(),
    startedAt: z.string().min(1),
    finalizedAt: z.string().min(1).nullable(),
  },
).strict();

export const UltraPlanScenarioStatusUpdateSchema = z.object(
  {
    stack: literalUnion(ULTRAPLAN_STACKS),
    domainId: z.string().min(1),
    level: literalUnion(ULTRAPLAN_LEVELS),
    scenarioId: z.string().min(1),
    nextStatus: literalUnion(ULTRAPLAN_SCENARIO_STATUSES),
    appendProof: UltraPlanProofSchema.optional(),
  },
).strict();

export const UltraPlanReviewStatusUpdateSchema = z.object(
  {
    type: literalUnion(["domain", "stack"] as const),
    stack: literalUnion(ULTRAPLAN_STACKS),
    domainId: z.string().min(1).nullable(),
    nextStatus: literalUnion(ULTRAPLAN_REVIEW_STATUSES),
    artifactRef: z.string().min(1).nullable(),
  },
).strict();

export const UltraPlanBlockerUpdateSchema = z.object(
  {
    scope: literalUnion(ULTRAPLAN_BLOCKER_SCOPES),
    nextValue: UltraPlanBlockerSchema.nullable(),
    clearedByObservationFingerprint: z.string().min(1).nullable(),
  },
).strict();

export const UltraPlanRepairActionSchema = z.union([
  z.object(
    {
      op: z.literal("recompute-cursor"),
      reason: z.string().min(1),
    },
  ).strict(),
  z.object(
    {
      op: z.literal("recompute-progress"),
      reason: z.string().min(1),
    },
  ).strict(),
  z.object(
    {
      op: z.literal("clear-active-attempt"),
      reason: z.string().min(1),
    },
  ).strict(),
  z.object(
    {
      op: z.literal("convert-active-to-interrupted"),
      attemptId: z.string().min(1),
      reason: z.string().min(1),
    },
  ).strict(),
  z.object(
    {
      op: z.literal("clear-blocker"),
      scope: literalUnion(ULTRAPLAN_BLOCKER_SCOPES),
      clearedByObservationFingerprint: z.string().min(1),
    },
  ).strict(),
]);

export const UltraPlanTrackerAttemptFinalizationSchema = z.object(
  {
    attemptId: z.string().min(1),
    outcome: literalUnion(ULTRAPLAN_ATTEMPT_OUTCOMES),
    finalizedAt: z.string().min(1),
  },
).strict();

export const UltraPlanMutationPlanSchema = z.object(
  {
    kind: literalUnion(ULTRAPLAN_MUTATION_KINDS),
    rationale: z.string().min(1),
    appendObservationFingerprint: z.string().min(1).nullable(),
    scenarioStatusUpdate: UltraPlanScenarioStatusUpdateSchema.nullable(),
    reviewStatusUpdate: UltraPlanReviewStatusUpdateSchema.nullable(),
    blockerUpdate: UltraPlanBlockerUpdateSchema.nullable(),
    cursorUpdate: UltraPlanCursorSchema.nullable(),
    sessionStateUpdate: literalUnion(ULTRAPLAN_SESSION_STATES).nullable(),
    trackerAttemptFinalization: UltraPlanTrackerAttemptFinalizationSchema.nullable(),
    recomputeProgress: z.boolean(),
    repairActions: z.array(UltraPlanRepairActionSchema),
    notes: z.array(z.string()),
  },
).strict();

export const UltraPlanPendingMutationSchema = z.object(
  {
    attemptId: z.string().min(1),
    mutationPlan: UltraPlanMutationPlanSchema,
    expectedManifestFingerprint: z.string().min(1),
    stagedAt: z.string().min(1),
  },
).strict();

export const UltraPlanRuntimeTrackerSchema = z.object(
  {
    version: z.literal(1),
    sessionId: z.string().min(1),
    activeAttempt: UltraPlanAttemptRecordSchema.nullable(),
    finalizedAttempts: z.array(UltraPlanAttemptRecordSchema),
    appliedFingerprints: z.array(z.string().min(1)),
    pendingMutation: UltraPlanPendingMutationSchema.nullable(),
    updatedAt: z.string().min(1),
  },
).strict();

export const UltraPlanRepairDetailsSchema = z.object(
  {
    reason: z.string().min(1),
    actions: z.array(UltraPlanRepairActionSchema),
  },
).strict();

export const UltraPlanReducerActionSchema = z.union([
  z.object(
    {
      kind: z.literal("session_started"),
      observation: UltraPlanHookObservationSchema,
      nowIso: z.string().min(1),
    },
  ).strict(),
  z.object(
    {
      kind: z.literal("attempt_started"),
      observation: UltraPlanHookObservationSchema,
      launchContext: UltraPlanLaunchContextSchema,
    },
  ).strict(),
  z.object(
    {
      kind: z.literal("observation_staged"),
      observation: UltraPlanHookObservationSchema,
    },
  ).strict(),
  z.object(
    {
      kind: z.literal("attempt_finalized"),
      observation: UltraPlanHookObservationSchema,
      nowIso: z.string().min(1),
    },
  ).strict(),
  z.object(
    {
      kind: z.literal("session_shutdown"),
      observation: UltraPlanHookObservationSchema,
      nowIso: z.string().min(1),
    },
  ).strict(),
  z.object(
    {
      kind: z.literal("repair_applied"),
      nowIso: z.string().min(1),
      details: UltraPlanRepairDetailsSchema,
    },
  ).strict(),
]);

export const UltraPlanSessionMigrationRecordSchema = z.object(
  {
    migratedAt: z.string().min(1),
    legacyPath: z.string().min(1),
    fingerprintBefore: z.string().min(1),
    fingerprintAfter: z.string().min(1),
    legacyRenamedTo: z.string().min(1).nullable(),
    kind: literalUnion(ULTRAPLAN_MIGRATION_KINDS),
  },
).strict();

// ---------------------------------------------------------------------------
// Semantic validators for contracts that express invariants above schema.
// ---------------------------------------------------------------------------

const PROOF_REQUIRED_SCENARIO_STATUSES = new Set<UltraPlanScenario["status"]>([
  "red-proved",
  "green-proved",
  "review-passed",
  "done",
]);

function getUltraPlanAttemptRecordSemanticErrors(attempt: UltraPlanAttemptRecord): string[] {
  const errors: string[] = [];
  // Finalized attempts must pair outcome with finalizedAt, and vice versa.
  const hasOutcome = attempt.outcome !== null;
  const hasFinalizedAt = attempt.finalizedAt !== null;
  if (hasOutcome !== hasFinalizedAt) {
    errors.push(
      "attempt record outcome and finalizedAt must both be null or both be set",
    );
  }
  return errors;
}

function getUltraPlanMutationPlanSemanticErrors(plan: UltraPlanMutationPlan): string[] {
  const errors: string[] = [];

  const advancesScenarioWithProof = plan.scenarioStatusUpdate?.appendProof !== undefined;
  const advancesReviewToPassed = plan.reviewStatusUpdate?.nextStatus === "passed";
  const setsNewBlocker = plan.blockerUpdate !== null && plan.blockerUpdate.nextValue !== null;
  const advancesToProofRequiredStatus = plan.scenarioStatusUpdate
    ? PROOF_REQUIRED_SCENARIO_STATUSES.has(plan.scenarioStatusUpdate.nextStatus)
    : false;

  // Rule 1: a single plan must not simultaneously advance with proof and set a new blocker.
  if ((advancesScenarioWithProof || advancesReviewToPassed) && setsNewBlocker) {
    errors.push(
      "mutation plan cannot both advance with proof and set a new blocker in one attempt finalization",
    );
  }

  // Rule 2: advancement to a proof-required scenario status must include appendProof.
  if (plan.scenarioStatusUpdate && advancesToProofRequiredStatus && plan.scenarioStatusUpdate.appendProof === undefined) {
    errors.push(
      `scenario advancement to ${plan.scenarioStatusUpdate.nextStatus} must include appendProof`,
    );
  }

  // Rule 3: a review advancement to passed must include an artifactRef for downstream validation.
  if (plan.reviewStatusUpdate && plan.reviewStatusUpdate.nextStatus === "passed"
    && plan.reviewStatusUpdate.artifactRef === null) {
    errors.push(
      "review advancement to passed must reference the validated review artifact",
    );
  }

  // Rule 4: a review update referring to a stack-level target must not carry a domainId.
  if (plan.reviewStatusUpdate && plan.reviewStatusUpdate.type === "stack"
    && plan.reviewStatusUpdate.domainId !== null) {
    errors.push("stack review update must have domainId null");
  }

  // Rule 5: kind must be consistent with the update envelope.
  if (plan.kind === "advance" && !plan.scenarioStatusUpdate && !plan.reviewStatusUpdate && !plan.sessionStateUpdate) {
    errors.push("advance mutation plan must carry at least one status update");
  }
  if (plan.kind === "block" && !setsNewBlocker) {
    errors.push("block mutation plan must set a non-null blocker");
  }
  if (plan.kind === "noop" && (plan.scenarioStatusUpdate || plan.reviewStatusUpdate || setsNewBlocker || plan.cursorUpdate || plan.sessionStateUpdate)) {
    errors.push("noop mutation plan must not carry any state update");
  }

  return errors;
}

function getUltraPlanRuntimeTrackerSemanticErrors(tracker: UltraPlanRuntimeTracker): string[] {
  const errors: string[] = [];
  if (tracker.activeAttempt) {
    errors.push(...getUltraPlanAttemptRecordSemanticErrors(tracker.activeAttempt));
  }
  for (const finalized of tracker.finalizedAttempts) {
    if (finalized.outcome === null || finalized.finalizedAt === null) {
      errors.push(`finalized attempt ${finalized.attemptId} must have outcome and finalizedAt set`);
    }
    errors.push(...getUltraPlanAttemptRecordSemanticErrors(finalized));
  }
  if (tracker.pendingMutation) {
    errors.push(...getUltraPlanMutationPlanSemanticErrors(tracker.pendingMutation.mutationPlan));
  }
  // Dedupe invariant: appliedFingerprints must not contain duplicates.
  const seen = new Set<string>();
  for (const fp of tracker.appliedFingerprints) {
    if (seen.has(fp)) {
      errors.push(`duplicate applied fingerprint ${fp}`);
    }
    seen.add(fp);
  }
  return errors;
}

function getUltraPlanSessionMigrationRecordSemanticErrors(record: UltraPlanSessionMigrationRecord): string[] {
  const errors: string[] = [];
  if (record.fingerprintBefore.trim().length === 0) {
    errors.push("fingerprintBefore must be a non-empty string");
  }
  if (record.fingerprintAfter.trim().length === 0) {
    errors.push("fingerprintAfter must be a non-empty string");
  }
  // legacyPath must be absolute. Windows drive letters like "C:\path" are absolute; POSIX absolute paths start with "/".
  if (!isAbsolutePathToken(record.legacyPath)) {
    errors.push(`legacyPath must be absolute, received ${record.legacyPath}`);
  }
  if (record.legacyRenamedTo !== null && !isAbsolutePathToken(record.legacyRenamedTo)) {
    errors.push(`legacyRenamedTo must be absolute when present, received ${record.legacyRenamedTo}`);
  }
  return errors;
}

function isAbsolutePathToken(candidate: string): boolean {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  if (candidate.startsWith("/")) return true;
  // Windows drive-rooted paths: "C:\\" or "C:/".
  return /^[A-Za-z]:[\/\\]/.test(candidate);
}

export function validateUltraPlanRuntimeTracker(value: unknown) {
  const validation = buildValidationResult<UltraPlanRuntimeTracker>(UltraPlanRuntimeTrackerSchema, value);
  if (!validation.ok) {
    return validation;
  }
  const semanticErrors = getUltraPlanRuntimeTrackerSemanticErrors(validation.value);
  if (semanticErrors.length > 0) {
    return { ok: false, errors: semanticErrors } as const;
  }
  return validation;
}

export function validateUltraPlanSessionMigrationRecord(value: unknown) {
  const validation = buildValidationResult<UltraPlanSessionMigrationRecord>(UltraPlanSessionMigrationRecordSchema, value);
  if (!validation.ok) {
    return validation;
  }
  const semanticErrors = getUltraPlanSessionMigrationRecordSemanticErrors(validation.value);
  if (semanticErrors.length > 0) {
    return { ok: false, errors: semanticErrors } as const;
  }
  return validation;
}

export function isUltraPlanLaunchContext(value: unknown): value is UltraPlanLaunchContext {
  return checkSchema(UltraPlanLaunchContextSchema, value);
}

export function isUltraPlanHookObservation(value: unknown): value is UltraPlanHookObservation {
  return checkSchema(UltraPlanHookObservationSchema, value);
}

export function isUltraPlanProofCandidate(value: unknown): value is UltraPlanProofCandidate {
  return checkSchema(UltraPlanProofCandidateSchema, value);
}

export function isUltraPlanBlockerCandidate(value: unknown): value is UltraPlanBlockerCandidate {
  return checkSchema(UltraPlanBlockerCandidateSchema, value);
}

export function isUltraPlanAttemptRecord(value: unknown): value is UltraPlanAttemptRecord {
  if (!checkSchema(UltraPlanAttemptRecordSchema, value)) return false;
  return getUltraPlanAttemptRecordSemanticErrors(value as UltraPlanAttemptRecord).length === 0;
}

export function isUltraPlanMutationPlan(value: unknown): value is UltraPlanMutationPlan {
  if (!checkSchema(UltraPlanMutationPlanSchema, value)) return false;
  return getUltraPlanMutationPlanSemanticErrors(value as UltraPlanMutationPlan).length === 0;
}

export function isUltraPlanPendingMutation(value: unknown): value is UltraPlanPendingMutation {
  return checkSchema(UltraPlanPendingMutationSchema, value);
}

export function isUltraPlanRuntimeTracker(value: unknown): value is UltraPlanRuntimeTracker {
  return validateUltraPlanRuntimeTracker(value).ok;
}

export function isUltraPlanReducerAction(value: unknown): value is UltraPlanReducerAction {
  return checkSchema(UltraPlanReducerActionSchema, value);
}

export function isUltraPlanSessionMigrationRecord(value: unknown): value is UltraPlanSessionMigrationRecord {
  return validateUltraPlanSessionMigrationRecord(value).ok;
}

export function isUltraPlanRepairAction(value: unknown): value is UltraPlanRepairAction {
  return checkSchema(UltraPlanRepairActionSchema, value);
}


// ---------------------------------------------------------------------------
// Slice 7 batch orchestration contracts.
// ---------------------------------------------------------------------------

export const ULTRAPLAN_BATCH_RUN_STATES = ["paused", "running", "blocked", "complete", "abandoned"] as const;
export const ULTRAPLAN_BATCH_NODE_STATES = [
  "pending",
  "preparing",
  "running",
  "merge-pending",
  "paused",
  "blocked",
  "awaiting-user",
  "merged",
  "abandoned",
] as const;
export const ULTRAPLAN_BATCH_NODE_BLOCKER_KINDS = ["dependency", "session", "merge", "supervisor"] as const;
export const ULTRAPLAN_BATCH_BLOCKER_CODES = [
  "project-identity-failed",
  "invalid-run",
  "supervisor-worktree-invalid",
  "base-drift",
  "merge-blocked",
] as const;
export const ULTRAPLAN_BATCH_JOURNAL_EVENT_TYPES = [
  "run-created",
  "lease-acquired",
  "lease-released",
  "node-preparing",
  "node-running",
  "node-paused",
  "node-blocked",
  "node-awaiting-user",
  "node-merge-pending",
  "node-merged",
  "node-abandoned",
  "cleanup-warning",
] as const;

export const UltraPlanBatchWaveSchema = z.object(
  {
    waveIndex: z.number().min(0),
    sessionIds: z.array(z.string().min(1)),
  },
).strict();

export const UltraPlanBatchNodeSchema = z.object(
  {
    nodeId: z.string().min(1),
    sessionId: z.string().min(1),
    title: z.string().min(1),
    waveIndex: z.number().min(0),
    dependencies: z.array(z.string().min(1)),
    state: literalUnion(ULTRAPLAN_BATCH_NODE_STATES),
    blockerKind: literalUnion(ULTRAPLAN_BATCH_NODE_BLOCKER_KINDS).nullable(),
    blockerSummary: z.string().min(1).nullable(),
    resumeRequestedAt: z.string().min(1).nullable(),
    branchName: z.string().min(1).nullable(),
    worktreePath: z.string().min(1).nullable(),
    updatedAt: z.string().min(1),
  },
).strict();

export const UltraPlanBatchRunSchema = z.object(
  {
    runId: z.string().min(1),
    projectRoot: z.string().min(1),
    baseBranch: z.string().min(1),
    baseHead: z.string().min(1),
    currentBaseHead: z.string().min(1),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    state: literalUnion(ULTRAPLAN_BATCH_RUN_STATES),
    maxParallelism: z.number().min(1),
    batchBlockerCode: literalUnion(ULTRAPLAN_BATCH_BLOCKER_CODES).nullable(),
    batchBlockerSummary: z.string().min(1).nullable(),
    batchResumeRequestedAt: z.string().min(1).nullable(),
    supervisorWorktreePath: z.string().min(1).nullable(),
    waves: z.array(UltraPlanBatchWaveSchema),
    nodes: z.array(UltraPlanBatchNodeSchema),
  },
).strict();

export const UltraPlanBatchActiveRunLeaseSchema = z.object(
  {
    runId: z.string().min(1),
    ownerSessionId: z.string().min(1).nullable(),
    leaseAcquiredAt: z.string().min(1).nullable(),
    leaseExpiresAt: z.string().min(1).nullable(),
    updatedAt: z.string().min(1),
  },
).strict();

export const UltraPlanBatchJournalEventSchema = z.object(
  {
    runId: z.string().min(1),
    sessionId: z.string().min(1).nullable(),
    type: literalUnion(ULTRAPLAN_BATCH_JOURNAL_EVENT_TYPES),
    recordedAt: z.string().min(1),
    summary: z.string().min(1),
    details: z.record(z.string(), z.unknown()).optional(),
  },
).strict();

function parseBatchLeaseTimestamp(errors: string[], fieldName: string, value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) {
    errors.push(`${fieldName} must be a valid ISO timestamp`);
    return null;
  }
  return millis;
}

function getUltraPlanBatchActiveRunLeaseSemanticErrors(lease: UltraPlanBatchActiveRunLease): string[] {
  const errors: string[] = [];
  const hasOwner = lease.ownerSessionId !== null;
  const hasAcquiredAt = lease.leaseAcquiredAt !== null;
  const hasExpiresAt = lease.leaseExpiresAt !== null;
  if (hasOwner !== hasAcquiredAt || hasOwner !== hasExpiresAt) {
    return ["lease ownerSessionId, leaseAcquiredAt, and leaseExpiresAt must be all present or all null"];
  }

  const acquiredAt = parseBatchLeaseTimestamp(errors, "leaseAcquiredAt", lease.leaseAcquiredAt);
  const expiresAt = parseBatchLeaseTimestamp(errors, "leaseExpiresAt", lease.leaseExpiresAt);
  if (acquiredAt !== null && expiresAt !== null && expiresAt <= acquiredAt) {
    errors.push("leaseExpiresAt must be after leaseAcquiredAt");
  }

  return errors;
}

export function validateUltraPlanBatchRun(value: unknown) {
  const validation = buildValidationResult<UltraPlanBatchRun>(UltraPlanBatchRunSchema, value);
  if (!validation.ok) {
    return validation;
  }

  const semanticErrors = getUltraPlanBatchGraphErrors(validation.value);
  if (semanticErrors.length > 0) {
    return { ok: false, errors: semanticErrors } as const;
  }

  return validation;
}

export function validateUltraPlanBatchActiveRunLease(value: unknown) {
  const validation = buildValidationResult<UltraPlanBatchActiveRunLease>(UltraPlanBatchActiveRunLeaseSchema, value);
  if (!validation.ok) {
    return validation;
  }

  const semanticErrors = getUltraPlanBatchActiveRunLeaseSemanticErrors(validation.value);
  if (semanticErrors.length > 0) {
    return { ok: false, errors: semanticErrors } as const;
  }

  return validation;
}

export function isUltraPlanBatchWave(value: unknown): value is UltraPlanBatchWave {
  return checkSchema(UltraPlanBatchWaveSchema, value);
}

export function isUltraPlanBatchNode(value: unknown): value is UltraPlanBatchNode {
  return checkSchema(UltraPlanBatchNodeSchema, value);
}

export function isUltraPlanBatchRun(value: unknown): value is UltraPlanBatchRun {
  return validateUltraPlanBatchRun(value).ok;
}

export function isUltraPlanBatchActiveRunLease(value: unknown): value is UltraPlanBatchActiveRunLease {
  return validateUltraPlanBatchActiveRunLease(value).ok;
}

export function isUltraPlanBatchJournalEvent(value: unknown): value is UltraPlanBatchJournalEvent {
  return checkSchema(UltraPlanBatchJournalEventSchema, value);
}
