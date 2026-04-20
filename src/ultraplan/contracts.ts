import { Type, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type {
  ResolvedUltraPlanCatalog,
  ResolvedUltraPlanSlotBinding,
  ThinkingLevel,
  UltraPlanAgentDefinitionFrontmatter,
  UltraPlanAgentSlotName,
  UltraPlanAgentSlots,
  UltraPlanAuthoredArtifact,
  UltraPlanBlocker,
  UltraPlanCursor,
  UltraPlanDomain,
  UltraPlanDomainReview,
  UltraPlanIndex,
  UltraPlanIndexEntry,
  UltraPlanManifest,
  UltraPlanProof,
  UltraPlanReviewerSlotName,
  UltraPlanScenario,
  UltraPlanStack,
  UltraPlanStackReview,
} from "../types.js";

export type {
  ResolvedUltraPlanCatalog,
  ResolvedUltraPlanSlotBinding,
  UltraPlanAgentDefinitionFrontmatter,
  UltraPlanAgentSlots,
  UltraPlanAuthoredArtifact,
  UltraPlanBlocker,
  UltraPlanCursor,
  UltraPlanDomain,
  UltraPlanDomainReview,
  UltraPlanIndex,
  UltraPlanIndexEntry,
  UltraPlanManifest,
  UltraPlanProof,
  UltraPlanScenario,
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
