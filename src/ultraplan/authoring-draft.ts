import type {
  ResolvedUltraPlanCatalog,
  ResolvedUltraPlanSlotBinding,
  UltraPlanAgentBinding,
  UltraPlanAgentSlotName,
  UltraPlanAgentSlots,
  UltraPlanApplicability,
  UltraPlanAuthoredArtifact,
  UltraPlanCursor,
  UltraPlanIndexEntry,
  UltraPlanManifest,
  UltraPlanReviewerSlotName,
  UltraPlanScenarioLevel,
  UltraPlanStack,
  UltraPlanStackId,
} from "../types.js";
import { isUltraPlanAuthoredArtifact, ULTRAPLAN_STACKS, UltraPlanAuthoredArtifactSchema, getUltraPlanSchemaErrors } from "./contracts.js";
import { ULTRAPLAN_AUTHORED_JSON_FILENAME } from "./project-paths.js";

/**
 * Authoring-time draft: structurally identical to `UltraPlanAuthoredArtifact` with
 * authoring-time invariants enforced by the operations in this module. The type alias
 * keeps downstream call sites honest — the draft is never a parallel shape.
 */
export type UltraPlanAuthoredDraft = UltraPlanAuthoredArtifact;

export type DraftOpResult =
  | { ok: true; draft: UltraPlanAuthoredDraft }
  | { ok: false; reason: DraftOpError };

export type DraftOpError =
  | { code: "duplicate-id"; where: "domain" | "scenario"; id: string }
  | { code: "not-found"; where: "stack" | "domain" | "scenario"; id: string }
  | { code: "invariant-violation"; path: string; message: string }
  | { code: "length-cap"; field: string; max: number; got: number }
  | { code: "bad-applicability-transition"; message: string };

export type DraftReadiness =
  | { ok: true }
  | { ok: false; blockers: DraftReadinessBlocker[] };

export type DraftReadinessBlocker =
  | { code: "empty-session" }
  | { code: "empty-applicable-stack"; stack: UltraPlanStackId }
  | { code: "empty-domain"; stack: UltraPlanStackId; domainId: string }
  | { code: "missing-required-slot"; stack: UltraPlanStackId; slot: UltraPlanAgentSlotName };

const ZERO_PROGRESS = { total: 0, terminal: 0, blocked: 0 } as const;

export const SESSION_TITLE_MAX = 80;
export const SESSION_GOAL_MAX = 280;
export const DOMAIN_NAME_MAX = 60;
export const SCENARIO_TITLE_MAX = 120;

function codePointLength(str: string): number {
  return [...str].length;
}

function lengthCap(field: string, max: number, value: string): DraftOpError | null {
  const got = codePointLength(value);
  if (got === 0 || got > max) {
    return { code: "length-cap", field, max, got };
  }
  return null;
}

export function slugifyUltraPlanId(raw: string, maxLength = 32): string {
  return raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength) || "item";
}

function validateDraft(draft: UltraPlanAuthoredDraft): DraftOpResult {
  if (isUltraPlanAuthoredArtifact(draft)) {
    return { ok: true, draft };
  }
  const errors = getUltraPlanSchemaErrors(UltraPlanAuthoredArtifactSchema, draft);
  const first = errors[0] ?? "/ validation failed";
  const spaceAt = first.indexOf(" ");
  const path = spaceAt > 0 ? first.slice(0, spaceAt) : "/";
  const message = spaceAt > 0 ? first.slice(spaceAt + 1) : first;
  return { ok: false, reason: { code: "invariant-violation", path, message } };
}

function isGateEnabled(
  catalog: ResolvedUltraPlanCatalog,
  reviewer: UltraPlanReviewerSlotName,
): boolean {
  return catalog.reviewGates[reviewer]?.enabled ?? true;
}

function projectBinding(source: ResolvedUltraPlanSlotBinding): UltraPlanAgentBinding {
  return {
    slot: source.slot,
    agentType: source.agentType,
    agentName: source.agentName,
    model: source.model,
    thinkingLevel: source.thinkingLevel,
  };
}

function buildStackAgentSlots(
  stack: UltraPlanStackId,
  catalog: ResolvedUltraPlanCatalog,
): UltraPlanAgentSlots {
  const executorSlot: UltraPlanAgentSlotName = `${stack}-executor`;
  const testerSlot: UltraPlanAgentSlotName = `${stack}-tester`;
  const domainReviewerSlot = `${stack}-domain-reviewer` as UltraPlanReviewerSlotName;
  const stackReviewerSlot = `${stack}-stack-reviewer` as UltraPlanReviewerSlotName;

  const executor = catalog.slots[executorSlot];
  const tester = catalog.slots[testerSlot];
  if (!executor) {
    throw new Error(`buildInitialAuthoredDraft: catalog is missing required slot ${executorSlot}`);
  }
  if (!tester) {
    throw new Error(`buildInitialAuthoredDraft: catalog is missing required slot ${testerSlot}`);
  }

  const domainReviewEnabled = isGateEnabled(catalog, domainReviewerSlot);
  const stackReviewEnabled = isGateEnabled(catalog, stackReviewerSlot);

  const slots: UltraPlanAgentSlots = {
    executor: projectBinding(executor),
    tester: projectBinding(tester),
    domainReviewEnabled,
    stackReviewEnabled,
  };

  if (domainReviewEnabled) {
    const reviewer = catalog.slots[domainReviewerSlot];
    if (!reviewer) {
      throw new Error(
        `buildInitialAuthoredDraft: catalog is missing required slot ${domainReviewerSlot} while the gate is enabled`,
      );
    }
    slots.domainReviewer = projectBinding(reviewer);
  }

  if (stackReviewEnabled) {
    const reviewer = catalog.slots[stackReviewerSlot];
    if (!reviewer) {
      throw new Error(
        `buildInitialAuthoredDraft: catalog is missing required slot ${stackReviewerSlot} while the gate is enabled`,
      );
    }
    slots.stackReviewer = projectBinding(reviewer);
  }

  return slots;
}

export function buildInitialAuthoredDraft(params: {
  sessionId: string;
  title: string;
  goal: string;
  createdAt: Date;
  catalog: ResolvedUltraPlanCatalog;
}): UltraPlanAuthoredDraft {
  if (!params.sessionId) {
    throw new Error("buildInitialAuthoredDraft: sessionId must be non-empty");
  }
  if (!params.title) {
    throw new Error("buildInitialAuthoredDraft: title must be non-empty");
  }
  if (!params.goal) {
    throw new Error("buildInitialAuthoredDraft: goal must be non-empty");
  }

  const createdAtIso = params.createdAt.toISOString();
  const stacks: UltraPlanStack[] = ULTRAPLAN_STACKS.map((stack) => ({
    stack,
    applicability: "applicable" as const,
    domains: [],
    status: "ready" as const,
    agentSlots: buildStackAgentSlots(stack, params.catalog),
    progress: { ...ZERO_PROGRESS },
  }));

  return {
    sessionId: params.sessionId,
    title: params.title,
    goal: params.goal,
    createdAt: createdAtIso,
    updatedAt: createdAtIso,
    stacks,
  };
}

export function setSessionTitleAndGoal(
  draft: UltraPlanAuthoredDraft,
  patch: { title?: string; goal?: string },
): DraftOpResult {
  if (patch.title !== undefined) {
    const err = lengthCap("title", SESSION_TITLE_MAX, patch.title);
    if (err) return { ok: false, reason: err };
  }
  if (patch.goal !== undefined) {
    const err = lengthCap("goal", SESSION_GOAL_MAX, patch.goal);
    if (err) return { ok: false, reason: err };
  }

  const candidate: UltraPlanAuthoredDraft = {
    ...draft,
    title: patch.title ?? draft.title,
    goal: patch.goal ?? draft.goal,
  };
  return validateDraft(candidate);
}

export function setSessionId(draft: UltraPlanAuthoredDraft, sessionId: string): DraftOpResult {
  if (codePointLength(sessionId) === 0) {
    return { ok: false, reason: { code: "length-cap", field: "sessionId", max: 128, got: 0 } };
  }
  const candidate: UltraPlanAuthoredDraft = { ...draft, sessionId };
  return validateDraft(candidate);
}

export function setStackApplicability(
  draft: UltraPlanAuthoredDraft,
  stack: UltraPlanStackId,
  applicability: UltraPlanApplicability,
): DraftOpResult {
  const index = draft.stacks.findIndex((s) => s.stack === stack);
  if (index === -1) {
    return { ok: false, reason: { code: "not-found", where: "stack", id: stack as string } };
  }

  const current = draft.stacks[index];
  if (current.applicability === applicability) {
    return { ok: true, draft };
  }

  const nextStack: UltraPlanStack = applicability === "not-applicable"
    ? {
      ...current,
      applicability,
      domains: [],
      progress: { ...ZERO_PROGRESS },
    }
    : {
      ...current,
      applicability,
      domains: [],
      progress: { ...ZERO_PROGRESS },
    };

  const stacks = draft.stacks.slice();
  stacks[index] = nextStack;
  return validateDraft({ ...draft, stacks });
}

function recomputeStackProgress(stack: UltraPlanStack): UltraPlanStack {
  let total = 0;
  let terminal = 0;
  let blocked = 0;
  for (const domain of stack.domains) {
    total += domain.progress.total;
    terminal += domain.progress.terminal;
    blocked += domain.progress.blocked;
  }
  return { ...stack, progress: { total, terminal, blocked } };
}

function mutateStack(
  draft: UltraPlanAuthoredDraft,
  stackId: UltraPlanStackId,
  update: (stack: UltraPlanStack) => UltraPlanStack | DraftOpError,
): DraftOpResult {
  const index = draft.stacks.findIndex((s) => s.stack === stackId);
  if (index === -1) {
    return { ok: false, reason: { code: "not-found", where: "stack", id: stackId as string } };
  }
  const updated = update(draft.stacks[index]);
  if (!("stack" in updated) || typeof (updated as UltraPlanStack).stack !== "string") {
    return { ok: false, reason: updated as DraftOpError };
  }
  const stacks = draft.stacks.slice();
  stacks[index] = updated as UltraPlanStack;
  return validateDraft({ ...draft, stacks });
}

export function addDomain(
  draft: UltraPlanAuthoredDraft,
  stack: UltraPlanStackId,
  domain: { id: string; name: string },
): DraftOpResult {
  const idErr = lengthCap("domain.id", 32, domain.id);
  if (idErr) return { ok: false, reason: idErr };
  const nameErr = lengthCap("domain.name", DOMAIN_NAME_MAX, domain.name);
  if (nameErr) return { ok: false, reason: nameErr };

  return mutateStack(draft, stack, (current) => {
    if (current.domains.some((d) => d.id === domain.id)) {
      return { code: "duplicate-id", where: "domain", id: domain.id };
    }
    const newDomain = {
      id: domain.id,
      name: domain.name,
      unit: [],
      integration: [],
      e2e: [],
      review: {
        enabled: current.agentSlots.domainReviewEnabled,
        status: "pending" as const,
      },
      progress: { ...ZERO_PROGRESS },
    };
    const next: UltraPlanStack = {
      ...current,
      domains: [...current.domains, newDomain],
    };
    return recomputeStackProgress(next);
  });
}

export function renameDomain(
  draft: UltraPlanAuthoredDraft,
  stack: UltraPlanStackId,
  domainId: string,
  patch: { name: string },
): DraftOpResult {
  const nameErr = lengthCap("domain.name", DOMAIN_NAME_MAX, patch.name);
  if (nameErr) return { ok: false, reason: nameErr };

  return mutateStack(draft, stack, (current) => {
    const domainIndex = current.domains.findIndex((d) => d.id === domainId);
    if (domainIndex === -1) {
      return { code: "not-found", where: "domain", id: domainId };
    }
    const domains = current.domains.slice();
    domains[domainIndex] = { ...domains[domainIndex], name: patch.name };
    return { ...current, domains };
  });
}

export function removeDomain(
  draft: UltraPlanAuthoredDraft,
  stack: UltraPlanStackId,
  domainId: string,
): DraftOpResult {
  return mutateStack(draft, stack, (current) => {
    const domainIndex = current.domains.findIndex((d) => d.id === domainId);
    if (domainIndex === -1) {
      return { code: "not-found", where: "domain", id: domainId };
    }
    const next: UltraPlanStack = {
      ...current,
      domains: current.domains.filter((_, i) => i !== domainIndex),
    };
    return recomputeStackProgress(next);
  });
}

function recomputeDomainProgress<T extends { unit: unknown[]; integration: unknown[]; e2e: unknown[]; progress: { total: number; terminal: number; blocked: number } }>(domain: T): T {
  const total = domain.unit.length + domain.integration.length + domain.e2e.length;
  return { ...domain, progress: { total, terminal: 0, blocked: 0 } };
}

function mutateDomain(
  draft: UltraPlanAuthoredDraft,
  coord: { stack: UltraPlanStackId; domainId: string },
  update: (domain: UltraPlanStack["domains"][number], stack: UltraPlanStack) => UltraPlanStack["domains"][number] | DraftOpError,
): DraftOpResult {
  return mutateStack(draft, coord.stack, (current) => {
    const domainIndex = current.domains.findIndex((d) => d.id === coord.domainId);
    if (domainIndex === -1) {
      return { code: "not-found", where: "domain", id: coord.domainId };
    }
    const updated = update(current.domains[domainIndex], current);
    if (!("id" in updated) || typeof (updated as { id?: unknown }).id !== "string" || "code" in updated) {
      return updated as DraftOpError;
    }
    const domains = current.domains.slice();
    domains[domainIndex] = updated as UltraPlanStack["domains"][number];
    return recomputeStackProgress({ ...current, domains });
  });
}

function scenarioAssignedSlots(stack: UltraPlanStack, level: UltraPlanScenarioLevel): UltraPlanAgentSlotName[] {
  if (level === "unit") {
    return [stack.agentSlots.executor.slot];
  }
  return [stack.agentSlots.tester.slot, stack.agentSlots.executor.slot];
}

export function addScenario(
  draft: UltraPlanAuthoredDraft,
  coord: { stack: UltraPlanStackId; domainId: string; level: UltraPlanScenarioLevel },
  scenario: { id: string; title: string; steps?: string[]; dependencies?: string[] },
): DraftOpResult {
  const idErr = lengthCap("scenario.id", 48, scenario.id);
  if (idErr) return { ok: false, reason: idErr };
  const titleErr = lengthCap("scenario.title", SCENARIO_TITLE_MAX, scenario.title);
  if (titleErr) return { ok: false, reason: titleErr };

  return mutateDomain(draft, coord, (domain, stack) => {
    const bucket = domain[coord.level];
    if (bucket.some((s) => s.id === scenario.id)) {
      return { code: "duplicate-id", where: "scenario", id: scenario.id };
    }
    const newScenario = {
      id: scenario.id,
      title: scenario.title,
      stack: coord.stack,
      domainId: coord.domainId,
      level: coord.level,
      status: "planned" as const,
      steps: scenario.steps ?? [],
      assignedSlots: scenarioAssignedSlots(stack, coord.level),
      ...(scenario.dependencies && scenario.dependencies.length > 0 ? { dependencies: scenario.dependencies } : {}),
      proofs: [],
    };
    const nextDomain = {
      ...domain,
      [coord.level]: [...bucket, newScenario],
    };
    return recomputeDomainProgress(nextDomain);
  });
}

export function renameScenario(
  draft: UltraPlanAuthoredDraft,
  coord: {
    stack: UltraPlanStackId;
    domainId: string;
    level: UltraPlanScenarioLevel;
    scenarioId: string;
  },
  patch: { title: string },
): DraftOpResult {
  const titleErr = lengthCap("scenario.title", SCENARIO_TITLE_MAX, patch.title);
  if (titleErr) return { ok: false, reason: titleErr };

  return mutateDomain(draft, coord, (domain) => {
    const bucket = domain[coord.level];
    const scenarioIndex = bucket.findIndex((s) => s.id === coord.scenarioId);
    if (scenarioIndex === -1) {
      return { code: "not-found", where: "scenario", id: coord.scenarioId };
    }
    const nextBucket = bucket.slice();
    nextBucket[scenarioIndex] = { ...nextBucket[scenarioIndex], title: patch.title };
    return { ...domain, [coord.level]: nextBucket };
  });
}

export function removeScenario(
  draft: UltraPlanAuthoredDraft,
  coord: {
    stack: UltraPlanStackId;
    domainId: string;
    level: UltraPlanScenarioLevel;
    scenarioId: string;
  },
): DraftOpResult {
  return mutateDomain(draft, coord, (domain) => {
    const bucket = domain[coord.level];
    const scenarioIndex = bucket.findIndex((s) => s.id === coord.scenarioId);
    if (scenarioIndex === -1) {
      return { code: "not-found", where: "scenario", id: coord.scenarioId };
    }
    const nextBucket = bucket.filter((_, i) => i !== scenarioIndex);
    const nextDomain = { ...domain, [coord.level]: nextBucket };
    return recomputeDomainProgress(nextDomain);
  });
}

const LEVEL_ORDER: readonly UltraPlanScenarioLevel[] = ["unit", "integration", "e2e"];

function domainReviewRelativePath(stack: UltraPlanStackId, domainId: string): string {
  return `review/${stack}/domains/${domainId}.json`;
}

function stackReviewRelativePath(stack: UltraPlanStackId): string {
  return `review/${stack}/stack.json`;
}

export function draftToAuthoredArtifact(
  draft: UltraPlanAuthoredDraft,
  now: Date,
): UltraPlanAuthoredArtifact {
  return {
    sessionId: draft.sessionId,
    title: draft.title,
    goal: draft.goal,
    createdAt: draft.createdAt,
    updatedAt: now.toISOString(),
    stacks: draft.stacks,
  };
}

export function draftToManifest(
  draft: UltraPlanAuthoredDraft,
  projectName: string,
  now: Date,
): UltraPlanManifest {
  const stacks = draft.stacks.map((stack) => ({
    stack: stack.stack,
    applicability: stack.applicability,
    progress: { ...stack.progress },
    domainCount: stack.domains.length,
    terminalDomainCount: 0,
  }));

  let totalScenarios = 0;
  for (const stack of draft.stacks) {
    totalScenarios += stack.progress.total;
  }

  const reviews: UltraPlanManifest["reviews"] = [];
  for (const stack of draft.stacks) {
    if (stack.applicability !== "applicable") continue;
    if (stack.agentSlots.domainReviewEnabled) {
      for (const domain of stack.domains) {
        reviews.push({
          type: "domain",
          stack: stack.stack,
          domainId: domain.id,
          path: domainReviewRelativePath(stack.stack, domain.id),
          status: "pending",
        });
      }
    }
    if (stack.agentSlots.stackReviewEnabled) {
      reviews.push({
        type: "stack",
        stack: stack.stack,
        domainId: null,
        path: stackReviewRelativePath(stack.stack),
        status: "pending",
      });
    }
  }

  return {
    sessionId: draft.sessionId,
    projectName,
    title: draft.title,
    authored: { json: ULTRAPLAN_AUTHORED_JSON_FILENAME },
    state: "ready",
    cursor: initialCursor(draft),
    lastCompleted: null,
    progress: { total: totalScenarios, terminal: 0, blocked: 0 },
    stacks,
    blocker: null,
    reviews,
    createdAt: draft.createdAt,
    updatedAt: now.toISOString(),
  };
}

export function draftToIndexEntry(
  draft: UltraPlanAuthoredDraft,
  now: Date,
): UltraPlanIndexEntry {
  return {
    sessionId: draft.sessionId,
    title: draft.title,
    state: "ready",
    bucket: "pending",
    createdAt: draft.createdAt,
    updatedAt: now.toISOString(),
    cursor: initialCursor(draft),
    idleReason: null,
  };
}

export function initialCursor(draft: UltraPlanAuthoredDraft): UltraPlanCursor {
  for (const stack of draft.stacks) {
    if (stack.applicability !== "applicable") continue;
    for (const domain of stack.domains) {
      for (const level of LEVEL_ORDER) {
        const bucket = domain[level];
        if (bucket.length === 0) continue;
        const scenario = bucket[0];
        return {
          targetType: "scenario",
          stack: stack.stack,
          domainId: domain.id,
          level,
          scenarioId: scenario.id,
          phase: "red",
          status: "planned",
          summary: scenario.title,
        };
      }
    }
  }

  // Fallback — a non-persist-ready draft with no scenarios. Projections still need a valid cursor
  // to satisfy the schema; the readiness gate prevents reaching persist here.
  return {
    targetType: "session",
    stack: null,
    domainId: null,
    level: null,
    scenarioId: null,
    phase: "complete",
    status: "ready",
    summary: "No scenarios authored yet",
  };
}

export function isDraftReadyToPersist(draft: UltraPlanAuthoredDraft): DraftReadiness {
  const blockers: DraftReadinessBlocker[] = [];
  const applicableStacks = draft.stacks.filter((s) => s.applicability === "applicable");

  if (applicableStacks.length === 0) {
    blockers.push({ code: "empty-session" });
  }

  for (const stack of applicableStacks) {
    // Defensive: reject bypassed drafts whose required slots have been nulled.
    const slots = stack.agentSlots as {
      executor?: unknown;
      tester?: unknown;
      domainReviewEnabled?: boolean;
      stackReviewEnabled?: boolean;
      domainReviewer?: unknown;
      stackReviewer?: unknown;
    };
    if (!slots.executor) {
      blockers.push({ code: "missing-required-slot", stack: stack.stack, slot: `${stack.stack}-executor` as UltraPlanAgentSlotName });
    }
    if (!slots.tester) {
      blockers.push({ code: "missing-required-slot", stack: stack.stack, slot: `${stack.stack}-tester` as UltraPlanAgentSlotName });
    }
    if (slots.domainReviewEnabled && !slots.domainReviewer) {
      blockers.push({ code: "missing-required-slot", stack: stack.stack, slot: `${stack.stack}-domain-reviewer` as UltraPlanAgentSlotName });
    }
    if (slots.stackReviewEnabled && !slots.stackReviewer) {
      blockers.push({ code: "missing-required-slot", stack: stack.stack, slot: `${stack.stack}-stack-reviewer` as UltraPlanAgentSlotName });
    }

    if (stack.domains.length === 0) {
      blockers.push({ code: "empty-applicable-stack", stack: stack.stack });
      continue;
    }

    for (const domain of stack.domains) {
      const total = domain.unit.length + domain.integration.length + domain.e2e.length;
      if (total === 0) {
        blockers.push({ code: "empty-domain", stack: stack.stack, domainId: domain.id });
      }
    }
  }

  return blockers.length === 0 ? { ok: true } : { ok: false, blockers };
}
