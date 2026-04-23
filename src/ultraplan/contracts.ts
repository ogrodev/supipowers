import { Type, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
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

export type {
  ResolvedUltraPlanCatalog,
  ResolvedUltraPlanSlotBinding,
  UltraPlanActorKind,
  UltraPlanAgentDefinitionFrontmatter,
  UltraPlanAgentSlots,
  UltraPlanAttemptOutcome,
  UltraPlanAttemptRecord,
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

function keyedObject(keys: readonly string[], valueSchema: TSchema) {
  return Type.Object(
    Object.fromEntries(keys.map((key) => [key, valueSchema])) as Record<string, TSchema>,
    { additionalProperties: false },
  );
}

function sparseKeyedObject(keys: readonly string[], valueSchema: TSchema) {
  return Type.Partial(keyedObject(keys, valueSchema));
}



function literalUnion<const TValue extends readonly string[]>(values: TValue) {
  return Type.Union(values.map((value) => Type.Literal(value)));
}

export const UltraPlanProgressSummarySchema = Type.Object(
  {
    total: Type.Number({ minimum: 0 }),
    terminal: Type.Number({ minimum: 0 }),
    blocked: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const UltraPlanAffectedUnitRefSchema = Type.Object(
  {
    stack: Type.Union([literalUnion(ULTRAPLAN_STACKS), Type.Null()]),
    domainId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    level: Type.Union([literalUnion(ULTRAPLAN_LEVELS), Type.Null()]),
    scenarioId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  },
  { additionalProperties: false },
);

export const UltraPlanProofEvidenceSchema = Type.Object(
  {
    summary: Type.String({ minLength: 1 }),
    command: Type.Optional(Type.String({ minLength: 1 })),
    outputRef: Type.Optional(Type.String({ minLength: 1 })),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

export const UltraPlanProofSchema = Type.Object(
  {
    type: literalUnion(ULTRAPLAN_PROOF_TYPES),
    phase: literalUnion(ULTRAPLAN_EXECUTION_PHASES),
    recordedAt: Type.String({ minLength: 1 }),
    actor: Type.String({ minLength: 1 }),
    evidence: UltraPlanProofEvidenceSchema,
    artifactRef: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const UltraPlanBlockerSchema = Type.Object(
  {
    code: Type.String({ minLength: 1 }),
    message: Type.String({ minLength: 1 }),
    scope: literalUnion(ULTRAPLAN_BLOCKER_SCOPES),
    affected: UltraPlanAffectedUnitRefSchema,
    recoverable: Type.Boolean(),
    recoveryMode: literalUnion(ULTRAPLAN_RECOVERY_MODES),
    nextAction: Type.String({ minLength: 1 }),
    retryable: Type.Boolean(),
    detectedAt: Type.String({ minLength: 1 }),
    details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

export const UltraPlanAgentBindingSchema = Type.Object(
  {
    slot: literalUnion(ULTRAPLAN_AGENT_SLOT_NAMES),
    agentType: literalUnion(ULTRAPLAN_AGENT_TYPES),
    agentName: Type.String({ minLength: 1 }),
    model: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    thinkingLevel: Type.Union([literalUnion(ULTRAPLAN_THINKING_LEVELS), Type.Null()]),
  },
  { additionalProperties: false },
);

export const UltraPlanAgentSlotsSchema = Type.Object(
  {
    executor: UltraPlanAgentBindingSchema,
    tester: UltraPlanAgentBindingSchema,
    domainReviewEnabled: Type.Boolean(),
    stackReviewEnabled: Type.Boolean(),
    domainReviewer: Type.Optional(UltraPlanAgentBindingSchema),
    stackReviewer: Type.Optional(UltraPlanAgentBindingSchema),
  },
  { additionalProperties: false },
);

export const UltraPlanSlotOverrideSchema = Type.Object(
  {
    agentName: Type.Optional(Type.String({ minLength: 1 })),
    model: Type.Optional(Type.String({ minLength: 1 })),
    thinkingLevel: Type.Optional(literalUnion(ULTRAPLAN_THINKING_LEVELS)),
  },
  { additionalProperties: false },
);

export const UltraPlanReviewGatePolicySchema = Type.Object(
  {
    enabled: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const UltraPlanConfigSchema = Type.Object(
  {
    slots: Type.Optional(sparseKeyedObject(ULTRAPLAN_AGENT_SLOT_NAMES, UltraPlanSlotOverrideSchema)),
    reviewGates: Type.Optional(
      sparseKeyedObject(ULTRAPLAN_REVIEWER_SLOT_NAMES, UltraPlanReviewGatePolicySchema),
    ),
  },
  { additionalProperties: false },
);

export const UltraPlanAgentDefinitionFrontmatterSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    description: Type.String({ minLength: 1 }),
    supportedSlots: Type.Array(literalUnion(ULTRAPLAN_AGENT_SLOT_NAMES), { minItems: 1 }),
    model: Type.Optional(Type.String({ minLength: 1 })),
    thinkingLevel: Type.Optional(literalUnion(ULTRAPLAN_THINKING_LEVELS)),
    focus: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const ResolvedUltraPlanSlotBindingSchema = Type.Object(
  {
    slot: literalUnion(ULTRAPLAN_AGENT_SLOT_NAMES),
    agentType: literalUnion(ULTRAPLAN_AGENT_TYPES),
    agentName: Type.String({ minLength: 1 }),
    model: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    thinkingLevel: Type.Union([literalUnion(ULTRAPLAN_THINKING_LEVELS), Type.Null()]),
    selectionSource: literalUnion(ULTRAPLAN_SELECTION_SOURCES),
    definitionSource: literalUnion(ULTRAPLAN_DEFINITION_SOURCES),
    modelSource: literalUnion(ULTRAPLAN_RESOLVED_VALUE_SOURCES),
    thinkingLevelSource: literalUnion(ULTRAPLAN_RESOLVED_VALUE_SOURCES),
    definitionPath: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  },
  { additionalProperties: false },
);

export const ResolvedUltraPlanCatalogSchema = Type.Object(
  {
    slots: keyedObject(
      ULTRAPLAN_AGENT_SLOT_NAMES,
      Type.Union([ResolvedUltraPlanSlotBindingSchema, Type.Null()]),
    ),
    reviewGates: sparseKeyedObject(
      ULTRAPLAN_REVIEWER_SLOT_NAMES,
      UltraPlanReviewGatePolicySchema,
    ),
  },
  { additionalProperties: false },
);


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
  id: Type.String({ minLength: 1 }),
  title: Type.String({ minLength: 1 }),
  stack: literalUnion(ULTRAPLAN_STACKS),
  domainId: Type.String({ minLength: 1 }),
  level: literalUnion(ULTRAPLAN_LEVELS),
  steps: Type.Array(Type.String({ minLength: 1 })),
  assignedSlots: Type.Array(literalUnion(ULTRAPLAN_AGENT_SLOT_NAMES)),
  dependencies: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  blocker: Type.Optional(Type.Union([UltraPlanBlockerSchema, Type.Null()])),
};

export const UltraPlanScenarioSchema = Type.Union([
  Type.Object(
    {
      ...UltraPlanScenarioSharedShape,
      status: literalUnion(ULTRAPLAN_NON_TERMINAL_SCENARIO_STATUSES),
      proofs: Type.Array(UltraPlanProofSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...UltraPlanScenarioSharedShape,
      status: literalUnion(ULTRAPLAN_TERMINAL_SCENARIO_STATUSES),
      proofs: Type.Array(UltraPlanProofSchema, { minItems: 1 }),
    },
    { additionalProperties: false },
  ),
]);

export const UltraPlanDomainReviewGateSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    status: literalUnion(ULTRAPLAN_REVIEW_STATUSES),
  },
  { additionalProperties: false },
);

export const UltraPlanDomainSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1 }),
    unit: Type.Array(UltraPlanScenarioSchema),
    integration: Type.Array(UltraPlanScenarioSchema),
    e2e: Type.Array(UltraPlanScenarioSchema),
    review: UltraPlanDomainReviewGateSchema,
    progress: UltraPlanProgressSummarySchema,
  },
  { additionalProperties: false },
);

export const UltraPlanStackSchema = Type.Object(
  {
    stack: literalUnion(ULTRAPLAN_STACKS),
    applicability: literalUnion(ULTRAPLAN_APPLICABILITY),
    domains: Type.Array(UltraPlanDomainSchema),
    status: literalUnion(ULTRAPLAN_SESSION_STATES),
    agentSlots: UltraPlanAgentSlotsSchema,
    progress: UltraPlanProgressSummarySchema,
  },
  { additionalProperties: false },
);

export const UltraPlanCursorSchema = Type.Object(
  {
    targetType: literalUnion(ULTRAPLAN_CURSOR_TARGETS),
    stack: Type.Union([literalUnion(ULTRAPLAN_STACKS), Type.Null()]),
    domainId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    level: Type.Union([literalUnion(ULTRAPLAN_LEVELS), Type.Null()]),
    scenarioId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    phase: literalUnion(ULTRAPLAN_EXECUTION_PHASES),
    status: literalUnion([
      ...ULTRAPLAN_SCENARIO_STATUSES,
      ...ULTRAPLAN_REVIEW_STATUSES,
      ...ULTRAPLAN_SESSION_STATES,
    ] as const),
    summary: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const UltraPlanDomainReviewSchema = Type.Object(
  {
    stack: literalUnion(ULTRAPLAN_STACKS),
    domainId: Type.String({ minLength: 1 }),
    reviewerSlot: literalUnion(ULTRAPLAN_AGENT_SLOT_NAMES),
    status: literalUnion(ULTRAPLAN_REVIEW_STATUSES),
    startedAt: Type.String({ minLength: 1 }),
    completedAt: Type.Optional(Type.String({ minLength: 1 })),
    summary: Type.String({ minLength: 1 }),
    artifactRef: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const UltraPlanStackReviewSchema = Type.Object(
  {
    stack: literalUnion(ULTRAPLAN_STACKS),
    reviewerSlot: literalUnion(ULTRAPLAN_AGENT_SLOT_NAMES),
    status: literalUnion(ULTRAPLAN_REVIEW_STATUSES),
    startedAt: Type.String({ minLength: 1 }),
    completedAt: Type.Optional(Type.String({ minLength: 1 })),
    summary: Type.String({ minLength: 1 }),
    artifactRef: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const UltraPlanAuthoredArtifactSchema = Type.Object(
  {
    sessionId: Type.String({ minLength: 1 }),
    title: Type.String({ minLength: 1 }),
    goal: Type.String({ minLength: 1 }),
    createdAt: Type.String({ minLength: 1 }),
    updatedAt: Type.String({ minLength: 1 }),
    stacks: Type.Array(UltraPlanStackSchema),
  },
  { additionalProperties: false },
);

export const UltraPlanManifestAuthoredRefsSchema = Type.Object(
  {
    json: Type.String({ minLength: 1 }),
    markdown: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const UltraPlanManifestStackSummarySchema = Type.Object(
  {
    stack: literalUnion(ULTRAPLAN_STACKS),
    applicability: literalUnion(ULTRAPLAN_APPLICABILITY),
    progress: UltraPlanProgressSummarySchema,
    domainCount: Type.Number({ minimum: 0 }),
    terminalDomainCount: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const UltraPlanManifestReviewReferenceSchema = Type.Object(
  {
    type: literalUnion(["domain", "stack"] as const),
    stack: literalUnion(ULTRAPLAN_STACKS),
    domainId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    path: Type.String({ minLength: 1 }),
    status: literalUnion(ULTRAPLAN_REVIEW_STATUSES),
  },
  { additionalProperties: false },
);

export const UltraPlanManifestSchema = Type.Object(
  {
    sessionId: Type.String({ minLength: 1 }),
    projectName: Type.String({ minLength: 1 }),
    title: Type.String({ minLength: 1 }),
    authored: UltraPlanManifestAuthoredRefsSchema,
    state: literalUnion(ULTRAPLAN_SESSION_STATES),
    cursor: Type.Union([UltraPlanCursorSchema, Type.Null()]),
    lastCompleted: Type.Union([UltraPlanCursorSchema, Type.Null()]),
    progress: UltraPlanProgressSummarySchema,
    stacks: Type.Array(UltraPlanManifestStackSummarySchema),
    blocker: Type.Union([UltraPlanBlockerSchema, Type.Null()]),
    reviews: Type.Array(UltraPlanManifestReviewReferenceSchema),
    createdAt: Type.String({ minLength: 1 }),
    updatedAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const UltraPlanIndexEntrySchema = Type.Object(
  {
    sessionId: Type.String({ minLength: 1 }),
    title: Type.String({ minLength: 1 }),
    state: literalUnion(ULTRAPLAN_SESSION_STATES),
    bucket: literalUnion(ULTRAPLAN_SESSION_BUCKETS),
    createdAt: Type.String({ minLength: 1 }),
    updatedAt: Type.String({ minLength: 1 }),
    cursor: Type.Union([UltraPlanCursorSchema, Type.Null()]),
    idleReason: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  },
  { additionalProperties: false },
);

export const UltraPlanIndexSchema = Type.Object(
  {
    sessions: Type.Array(UltraPlanIndexEntrySchema),
  },
  { additionalProperties: false },
);

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
    ? `\"${types[0]}\"`
    : types.map((type) => `\"${type}\"`).join(" or ");
}

function formatUltraPlanTerminalProofRequirements(
  requirements: readonly UltraPlanTerminalProofRequirement[],
): string {
  return requirements
    .map((requirement) => `a \"${requirement.phase}\" proof of type ${formatUltraPlanRequiredProofTypes(requirement.types)}`)
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
      `/stacks/${scenario.stack}/domains/${scenario.domainId}/${level}/${scenario.id} terminal scenario \"${scenario.id}\" with status \"${scenario.status}\" requires at least one terminal proof: ${formatUltraPlanTerminalProofRequirements(requirements)}`,
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


export function getUltraPlanSchemaErrors(schema: TSchema, value: unknown): string[] {
  return [...Value.Errors(schema, value)].map((error) => `${error.path || "/"} ${error.message}`);
}

function buildValidationResult<T>(schema: TSchema, value: unknown):
  | { ok: true; value: T }
  | { ok: false; errors: string[] } {
  if (Value.Check(schema, value)) {
    return { ok: true, value: value as T };
  }

  return {
    ok: false,
    errors: getUltraPlanSchemaErrors(schema, value),
  };
}

export function validateUltraPlanIndex(value: unknown) {
  return buildValidationResult<UltraPlanIndex>(UltraPlanIndexSchema, value);
}

export function validateUltraPlanManifest(value: unknown) {
  return buildValidationResult<UltraPlanManifest>(UltraPlanManifestSchema, value);
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
  return Value.Check(UltraPlanAgentDefinitionFrontmatterSchema, value);
}

export function isResolvedUltraPlanSlotBinding(value: unknown): value is ResolvedUltraPlanSlotBinding {
  return Value.Check(ResolvedUltraPlanSlotBindingSchema, value);
}

export function isResolvedUltraPlanCatalog(value: unknown): value is ResolvedUltraPlanCatalog {
  return Value.Check(ResolvedUltraPlanCatalogSchema, value);
}


export function isUltraPlanProof(value: unknown): value is UltraPlanProof {
  return Value.Check(UltraPlanProofSchema, value);
}

export function isUltraPlanBlocker(value: unknown): value is UltraPlanBlocker {
  return Value.Check(UltraPlanBlockerSchema, value);
}

export function isUltraPlanScenario(value: unknown): value is UltraPlanScenario {
  return Value.Check(UltraPlanScenarioSchema, value)
    && hasRequiredUltraPlanScenarioProof(value as UltraPlanScenario);
}

export function isUltraPlanDomain(value: unknown): value is UltraPlanDomain {
  return Value.Check(UltraPlanDomainSchema, value);
}

export function isUltraPlanAgentSlots(value: unknown): value is UltraPlanAgentSlots {
  return Value.Check(UltraPlanAgentSlotsSchema, value);
}

export function isUltraPlanStack(value: unknown): value is UltraPlanStack {
  return Value.Check(UltraPlanStackSchema, value);
}

export function isUltraPlanCursor(value: unknown): value is UltraPlanCursor {
  return Value.Check(UltraPlanCursorSchema, value);
}

export function isUltraPlanDomainReview(value: unknown): value is UltraPlanDomainReview {
  return Value.Check(UltraPlanDomainReviewSchema, value);
}

export function isUltraPlanStackReview(value: unknown): value is UltraPlanStackReview {
  return Value.Check(UltraPlanStackReviewSchema, value);
}

export function isUltraPlanAuthoredArtifact(value: unknown): value is UltraPlanAuthoredArtifact {
  return validateUltraPlanAuthoredArtifact(value).ok;
}

export function isUltraPlanManifest(value: unknown): value is UltraPlanManifest {
  return Value.Check(UltraPlanManifestSchema, value);
}

export function isUltraPlanIndexEntry(value: unknown): value is UltraPlanIndexEntry {
  return Value.Check(UltraPlanIndexEntrySchema, value);
}

export function isUltraPlanIndex(value: unknown): value is UltraPlanIndex {
  return Value.Check(UltraPlanIndexSchema, value);
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

export const UltraPlanLaunchContextSchema = Type.Object(
  {
    attemptId: Type.String({ minLength: 1 }),
    attemptKey: Type.String({ minLength: 1 }),
    sourceAgent: literalUnion(ULTRAPLAN_SOURCE_AGENTS),
    launchedAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const UltraPlanObservationTargetSchema = Type.Object(
  {
    targetType: literalUnion(ULTRAPLAN_CURSOR_TARGETS),
    stack: Type.Union([literalUnion(ULTRAPLAN_STACKS), Type.Null()]),
    domainId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    level: Type.Union([literalUnion(ULTRAPLAN_LEVELS), Type.Null()]),
    scenarioId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    phase: literalUnion(ULTRAPLAN_EXECUTION_PHASES),
    resolvedSlot: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  },
  { additionalProperties: false },
);

export const UltraPlanObservationCorrelationFailureSchema = Type.Object(
  {
    reason: Type.String({ minLength: 1 }),
    details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

export const UltraPlanHookObservationSchema = Type.Object(
  {
    sessionId: Type.String({ minLength: 1 }),
    hookEvent: literalUnion(ULTRAPLAN_HOOK_EVENT_NAMES),
    actorKind: literalUnion(ULTRAPLAN_ACTOR_KINDS),
    attemptId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    attemptKey: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    sourceAgent: literalUnion(ULTRAPLAN_SOURCE_AGENTS),
    occurredAt: Type.String({ minLength: 1 }),
    causationId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    fingerprint: Type.String({ minLength: 1 }),
    target: Type.Union([UltraPlanObservationTargetSchema, Type.Null()]),
    correlationFailure: Type.Union([UltraPlanObservationCorrelationFailureSchema, Type.Null()]),
    payloadSummary: Type.String(),
  },
  { additionalProperties: false },
);

export const UltraPlanProofCandidateTargetSchema = Type.Object(
  {
    targetType: literalUnion(ULTRAPLAN_CURSOR_TARGETS),
    stack: Type.Union([literalUnion(ULTRAPLAN_STACKS), Type.Null()]),
    domainId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    level: Type.Union([literalUnion(ULTRAPLAN_LEVELS), Type.Null()]),
    scenarioId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  },
  { additionalProperties: false },
);

export const UltraPlanProofCandidateSchema = Type.Object(
  {
    phase: literalUnion(ULTRAPLAN_EXECUTION_PHASES),
    type: literalUnion(ULTRAPLAN_PROOF_TYPES),
    target: UltraPlanProofCandidateTargetSchema,
    evidence: UltraPlanProofEvidenceSchema,
    artifactRef: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    observationFingerprint: Type.String({ minLength: 1 }),
    fingerprint: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const UltraPlanBlockerCandidateSchema = Type.Object(
  {
    blocker: UltraPlanBlockerSchema,
    observationFingerprint: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const UltraPlanAttemptRecordSchema = Type.Object(
  {
    attemptId: Type.String({ minLength: 1 }),
    attemptKey: Type.String({ minLength: 1 }),
    launchContext: UltraPlanLaunchContextSchema,
    cursorSnapshot: Type.Union([UltraPlanCursorSchema, Type.Null()]),
    observations: Type.Array(UltraPlanHookObservationSchema),
    proofCandidates: Type.Array(UltraPlanProofCandidateSchema),
    blockerCandidates: Type.Array(UltraPlanBlockerCandidateSchema),
    outcome: Type.Union([literalUnion(ULTRAPLAN_ATTEMPT_OUTCOMES), Type.Null()]),
    startedAt: Type.String({ minLength: 1 }),
    finalizedAt: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  },
  { additionalProperties: false },
);

export const UltraPlanScenarioStatusUpdateSchema = Type.Object(
  {
    stack: literalUnion(ULTRAPLAN_STACKS),
    domainId: Type.String({ minLength: 1 }),
    level: literalUnion(ULTRAPLAN_LEVELS),
    scenarioId: Type.String({ minLength: 1 }),
    nextStatus: literalUnion(ULTRAPLAN_SCENARIO_STATUSES),
    appendProof: Type.Optional(UltraPlanProofSchema),
  },
  { additionalProperties: false },
);

export const UltraPlanReviewStatusUpdateSchema = Type.Object(
  {
    type: literalUnion(["domain", "stack"] as const),
    stack: literalUnion(ULTRAPLAN_STACKS),
    domainId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    nextStatus: literalUnion(ULTRAPLAN_REVIEW_STATUSES),
    artifactRef: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  },
  { additionalProperties: false },
);

export const UltraPlanBlockerUpdateSchema = Type.Object(
  {
    scope: literalUnion(ULTRAPLAN_BLOCKER_SCOPES),
    nextValue: Type.Union([UltraPlanBlockerSchema, Type.Null()]),
    clearedByObservationFingerprint: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  },
  { additionalProperties: false },
);

export const UltraPlanRepairActionSchema = Type.Union([
  Type.Object(
    {
      op: Type.Literal("recompute-cursor"),
      reason: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      op: Type.Literal("recompute-progress"),
      reason: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      op: Type.Literal("clear-active-attempt"),
      reason: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      op: Type.Literal("convert-active-to-interrupted"),
      attemptId: Type.String({ minLength: 1 }),
      reason: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      op: Type.Literal("clear-blocker"),
      scope: literalUnion(ULTRAPLAN_BLOCKER_SCOPES),
      clearedByObservationFingerprint: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
]);

export const UltraPlanTrackerAttemptFinalizationSchema = Type.Object(
  {
    attemptId: Type.String({ minLength: 1 }),
    outcome: literalUnion(ULTRAPLAN_ATTEMPT_OUTCOMES),
    finalizedAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const UltraPlanMutationPlanSchema = Type.Object(
  {
    kind: literalUnion(ULTRAPLAN_MUTATION_KINDS),
    rationale: Type.String({ minLength: 1 }),
    appendObservationFingerprint: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    scenarioStatusUpdate: Type.Union([UltraPlanScenarioStatusUpdateSchema, Type.Null()]),
    reviewStatusUpdate: Type.Union([UltraPlanReviewStatusUpdateSchema, Type.Null()]),
    blockerUpdate: Type.Union([UltraPlanBlockerUpdateSchema, Type.Null()]),
    cursorUpdate: Type.Union([UltraPlanCursorSchema, Type.Null()]),
    sessionStateUpdate: Type.Union([literalUnion(ULTRAPLAN_SESSION_STATES), Type.Null()]),
    trackerAttemptFinalization: Type.Union([UltraPlanTrackerAttemptFinalizationSchema, Type.Null()]),
    recomputeProgress: Type.Boolean(),
    repairActions: Type.Array(UltraPlanRepairActionSchema),
    notes: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

export const UltraPlanPendingMutationSchema = Type.Object(
  {
    attemptId: Type.String({ minLength: 1 }),
    mutationPlan: UltraPlanMutationPlanSchema,
    expectedManifestFingerprint: Type.String({ minLength: 1 }),
    stagedAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const UltraPlanRuntimeTrackerSchema = Type.Object(
  {
    version: Type.Literal(1),
    sessionId: Type.String({ minLength: 1 }),
    activeAttempt: Type.Union([UltraPlanAttemptRecordSchema, Type.Null()]),
    finalizedAttempts: Type.Array(UltraPlanAttemptRecordSchema),
    appliedFingerprints: Type.Array(Type.String({ minLength: 1 })),
    pendingMutation: Type.Union([UltraPlanPendingMutationSchema, Type.Null()]),
    updatedAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const UltraPlanRepairDetailsSchema = Type.Object(
  {
    reason: Type.String({ minLength: 1 }),
    actions: Type.Array(UltraPlanRepairActionSchema),
  },
  { additionalProperties: false },
);

export const UltraPlanReducerActionSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("session_started"),
      observation: UltraPlanHookObservationSchema,
      nowIso: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("attempt_started"),
      observation: UltraPlanHookObservationSchema,
      launchContext: UltraPlanLaunchContextSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("observation_staged"),
      observation: UltraPlanHookObservationSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("attempt_finalized"),
      observation: UltraPlanHookObservationSchema,
      nowIso: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("session_shutdown"),
      observation: UltraPlanHookObservationSchema,
      nowIso: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("repair_applied"),
      nowIso: Type.String({ minLength: 1 }),
      details: UltraPlanRepairDetailsSchema,
    },
    { additionalProperties: false },
  ),
]);

export const UltraPlanSessionMigrationRecordSchema = Type.Object(
  {
    migratedAt: Type.String({ minLength: 1 }),
    legacyPath: Type.String({ minLength: 1 }),
    fingerprintBefore: Type.String({ minLength: 1 }),
    fingerprintAfter: Type.String({ minLength: 1 }),
    legacyRenamedTo: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    kind: literalUnion(ULTRAPLAN_MIGRATION_KINDS),
  },
  { additionalProperties: false },
);

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
  return Value.Check(UltraPlanLaunchContextSchema, value);
}

export function isUltraPlanHookObservation(value: unknown): value is UltraPlanHookObservation {
  return Value.Check(UltraPlanHookObservationSchema, value);
}

export function isUltraPlanProofCandidate(value: unknown): value is UltraPlanProofCandidate {
  return Value.Check(UltraPlanProofCandidateSchema, value);
}

export function isUltraPlanBlockerCandidate(value: unknown): value is UltraPlanBlockerCandidate {
  return Value.Check(UltraPlanBlockerCandidateSchema, value);
}

export function isUltraPlanAttemptRecord(value: unknown): value is UltraPlanAttemptRecord {
  if (!Value.Check(UltraPlanAttemptRecordSchema, value)) return false;
  return getUltraPlanAttemptRecordSemanticErrors(value as UltraPlanAttemptRecord).length === 0;
}

export function isUltraPlanMutationPlan(value: unknown): value is UltraPlanMutationPlan {
  if (!Value.Check(UltraPlanMutationPlanSchema, value)) return false;
  return getUltraPlanMutationPlanSemanticErrors(value as UltraPlanMutationPlan).length === 0;
}

export function isUltraPlanPendingMutation(value: unknown): value is UltraPlanPendingMutation {
  return Value.Check(UltraPlanPendingMutationSchema, value);
}

export function isUltraPlanRuntimeTracker(value: unknown): value is UltraPlanRuntimeTracker {
  return validateUltraPlanRuntimeTracker(value).ok;
}

export function isUltraPlanReducerAction(value: unknown): value is UltraPlanReducerAction {
  return Value.Check(UltraPlanReducerActionSchema, value);
}

export function isUltraPlanSessionMigrationRecord(value: unknown): value is UltraPlanSessionMigrationRecord {
  return validateUltraPlanSessionMigrationRecord(value).ok;
}

export function isUltraPlanRepairAction(value: unknown): value is UltraPlanRepairAction {
  return Value.Check(UltraPlanRepairActionSchema, value);
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

export const UltraPlanBatchWaveSchema = Type.Object(
  {
    waveIndex: Type.Number({ minimum: 0 }),
    sessionIds: Type.Array(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const UltraPlanBatchNodeSchema = Type.Object(
  {
    nodeId: Type.String({ minLength: 1 }),
    sessionId: Type.String({ minLength: 1 }),
    title: Type.String({ minLength: 1 }),
    waveIndex: Type.Number({ minimum: 0 }),
    dependencies: Type.Array(Type.String({ minLength: 1 })),
    state: literalUnion(ULTRAPLAN_BATCH_NODE_STATES),
    blockerKind: Type.Union([literalUnion(ULTRAPLAN_BATCH_NODE_BLOCKER_KINDS), Type.Null()]),
    blockerSummary: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    resumeRequestedAt: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    branchName: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    worktreePath: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    updatedAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const UltraPlanBatchRunSchema = Type.Object(
  {
    runId: Type.String({ minLength: 1 }),
    projectRoot: Type.String({ minLength: 1 }),
    baseBranch: Type.String({ minLength: 1 }),
    baseHead: Type.String({ minLength: 1 }),
    currentBaseHead: Type.String({ minLength: 1 }),
    createdAt: Type.String({ minLength: 1 }),
    updatedAt: Type.String({ minLength: 1 }),
    state: literalUnion(ULTRAPLAN_BATCH_RUN_STATES),
    maxParallelism: Type.Number({ minimum: 1 }),
    batchBlockerCode: Type.Union([literalUnion(ULTRAPLAN_BATCH_BLOCKER_CODES), Type.Null()]),
    batchBlockerSummary: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    batchResumeRequestedAt: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    supervisorWorktreePath: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    waves: Type.Array(UltraPlanBatchWaveSchema),
    nodes: Type.Array(UltraPlanBatchNodeSchema),
  },
  { additionalProperties: false },
);

export const UltraPlanBatchActiveRunLeaseSchema = Type.Object(
  {
    runId: Type.String({ minLength: 1 }),
    ownerSessionId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    leaseAcquiredAt: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    leaseExpiresAt: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    updatedAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const UltraPlanBatchJournalEventSchema = Type.Object(
  {
    runId: Type.String({ minLength: 1 }),
    sessionId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    type: literalUnion(ULTRAPLAN_BATCH_JOURNAL_EVENT_TYPES),
    recordedAt: Type.String({ minLength: 1 }),
    summary: Type.String({ minLength: 1 }),
    details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

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
  return Value.Check(UltraPlanBatchWaveSchema, value);
}

export function isUltraPlanBatchNode(value: unknown): value is UltraPlanBatchNode {
  return Value.Check(UltraPlanBatchNodeSchema, value);
}

export function isUltraPlanBatchRun(value: unknown): value is UltraPlanBatchRun {
  return validateUltraPlanBatchRun(value).ok;
}

export function isUltraPlanBatchActiveRunLease(value: unknown): value is UltraPlanBatchActiveRunLease {
  return validateUltraPlanBatchActiveRunLease(value).ok;
}

export function isUltraPlanBatchJournalEvent(value: unknown): value is UltraPlanBatchJournalEvent {
  return Value.Check(UltraPlanBatchJournalEventSchema, value);
}