import type { Platform } from "../platform/types.js";
import type {
  UltraPlanCatalogError,
  UltraPlanScenarioLevel,
  UltraPlanStackId,
  UltraPlanStorageError,
} from "../types.js";
import {
  addDomain,
  addScenario,
  buildInitialAuthoredDraft,
  draftToAuthoredArtifact,
  draftToManifest,
  isDraftReadyToPersist,
  setSessionId,
  setStackApplicability,
  slugifyUltraPlanId,
  type DraftOpError,
  type UltraPlanAuthoredDraft,
} from "./authoring-draft.js";
import {
  collectMissingRequiredSlotErrors,
  defaultDependencies,
  type AuthoringDependencies,
} from "./authoring-wizard.js";
import type { AuthoringPersistResult } from "./authoring-persist.js";
import { ULTRAPLAN_LEVELS, ULTRAPLAN_STACKS } from "./contracts.js";
import { getUltraplanProjectName, getUltraplanSessionDir } from "./project-paths.js";

export interface UltraPlanAuthoringToolScenarioInput {
  id?: string;
  title: string;
  steps?: string[];
  dependencies?: string[];
}

export interface UltraPlanAuthoringToolScenarioWithLevelInput extends UltraPlanAuthoringToolScenarioInput {
  level?: UltraPlanScenarioLevel;
}

export interface UltraPlanAuthoringToolDomainInput {
  id?: string;
  name: string;
  unit?: UltraPlanAuthoringToolScenarioInput[];
  integration?: UltraPlanAuthoringToolScenarioInput[];
  e2e?: UltraPlanAuthoringToolScenarioInput[];
  scenarios?: UltraPlanAuthoringToolScenarioWithLevelInput[];
}

export interface UltraPlanAuthoringToolStackInput {
  stack: UltraPlanStackId;
  domains: UltraPlanAuthoringToolDomainInput[];
}

export interface UltraPlanAuthoringToolInput {
  title: string;
  goal: string;
  stacks: UltraPlanAuthoringToolStackInput[];
}

type NormalizedScenario = {
  id?: string;
  title: string;
  level: UltraPlanScenarioLevel;
  steps: string[];
  dependencies: string[];
};

type NormalizedDomain = {
  id?: string;
  name: string;
  scenarios: NormalizedScenario[];
};

type NormalizedStack = {
  stack: UltraPlanStackId;
  domains: NormalizedDomain[];
};

type NormalizedInput = {
  title: string;
  goal: string;
  stacks: NormalizedStack[];
};

type NormalizeResult<T> = { ok: true; value: T } | { ok: false; message: string };

export type UltraPlanAuthoringToolCreateResult =
  | {
      ok: true;
      sessionId: string;
      title: string;
      goal: string;
      authoredPath: string;
      manifestPath: string;
      indexPath: string;
      reclaimed: boolean;
    }
  | { ok: false; message: string; details?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, path: string): NormalizeResult<string> {
  if (typeof value !== "string") {
    return { ok: false, message: `${path} must be a string` };
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: false, message: `${path} must not be empty` };
  }
  return { ok: true, value: trimmed };
}

function optionalString(value: unknown, path: string): NormalizeResult<string | undefined> {
  if (value === undefined || value === null) {
    return { ok: true, value: undefined };
  }
  return nonEmptyString(value, path);
}

function stringList(value: unknown, path: string): NormalizeResult<string[]> {
  if (value === undefined || value === null) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(value)) {
    return { ok: false, message: `${path} must be an array of strings` };
  }
  const normalized: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = nonEmptyString(value[index], `${path}[${index}]`);
    if (!item.ok) return item;
    normalized.push(item.value);
  }
  return { ok: true, value: normalized };
}

function isUltraPlanStackId(value: string): value is UltraPlanStackId {
  return (ULTRAPLAN_STACKS as readonly string[]).includes(value);
}

function isUltraPlanScenarioLevel(value: string): value is UltraPlanScenarioLevel {
  return (ULTRAPLAN_LEVELS as readonly string[]).includes(value);
}

function normalizeScenario(
  raw: unknown,
  path: string,
  defaultLevel: UltraPlanScenarioLevel,
): NormalizeResult<NormalizedScenario> {
  if (typeof raw === "string") {
    const title = nonEmptyString(raw, path);
    if (!title.ok) return title;
    return { ok: true, value: { title: title.value, level: defaultLevel, steps: [], dependencies: [] } };
  }
  if (!isRecord(raw)) {
    return { ok: false, message: `${path} must be a scenario object or title string` };
  }

  const title = nonEmptyString(raw.title, `${path}.title`);
  if (!title.ok) return title;
  const id = optionalString(raw.id, `${path}.id`);
  if (!id.ok) return id;

  let level = defaultLevel;
  if (raw.level !== undefined && raw.level !== null) {
    const levelValue = nonEmptyString(raw.level, `${path}.level`);
    if (!levelValue.ok) return levelValue;
    if (!isUltraPlanScenarioLevel(levelValue.value)) {
      return { ok: false, message: `${path}.level must be one of ${ULTRAPLAN_LEVELS.join(", ")}` };
    }
    level = levelValue.value;
  }

  const steps = stringList(raw.steps, `${path}.steps`);
  if (!steps.ok) return steps;
  const dependencies = stringList(raw.dependencies, `${path}.dependencies`);
  if (!dependencies.ok) return dependencies;

  return {
    ok: true,
    value: {
      ...(id.value ? { id: id.value } : {}),
      title: title.value,
      level,
      steps: steps.value,
      dependencies: dependencies.value,
    },
  };
}

function normalizeScenarioBucket(
  raw: unknown,
  path: string,
  level: UltraPlanScenarioLevel,
): NormalizeResult<NormalizedScenario[]> {
  if (raw === undefined || raw === null) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, message: `${path} must be an array` };
  }
  const scenarios: NormalizedScenario[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const scenario = normalizeScenario(raw[index], `${path}[${index}]`, level);
    if (!scenario.ok) return scenario;
    scenarios.push(scenario.value);
  }
  return { ok: true, value: scenarios };
}

function normalizeDomain(raw: unknown, path: string): NormalizeResult<NormalizedDomain> {
  if (!isRecord(raw)) {
    return { ok: false, message: `${path} must be a domain object` };
  }
  const name = nonEmptyString(raw.name, `${path}.name`);
  if (!name.ok) return name;
  const id = optionalString(raw.id, `${path}.id`);
  if (!id.ok) return id;

  const scenarios: NormalizedScenario[] = [];
  for (const level of ULTRAPLAN_LEVELS) {
    const bucket = normalizeScenarioBucket(raw[level], `${path}.${level}`, level);
    if (!bucket.ok) return bucket;
    scenarios.push(...bucket.value);
  }
  const generic = normalizeScenarioBucket(raw.scenarios, `${path}.scenarios`, "unit");
  if (!generic.ok) return generic;
  scenarios.push(...generic.value);

  if (scenarios.length === 0) {
    return { ok: false, message: `${path} must include at least one scenario` };
  }

  return {
    ok: true,
    value: {
      ...(id.value ? { id: id.value } : {}),
      name: name.value,
      scenarios,
    },
  };
}

function normalizeStack(raw: unknown, path: string): NormalizeResult<NormalizedStack> {
  if (!isRecord(raw)) {
    return { ok: false, message: `${path} must be a stack object` };
  }
  const stack = nonEmptyString(raw.stack, `${path}.stack`);
  if (!stack.ok) return stack;
  if (!isUltraPlanStackId(stack.value)) {
    return { ok: false, message: `${path}.stack must be one of ${ULTRAPLAN_STACKS.join(", ")}` };
  }
  if (!Array.isArray(raw.domains)) {
    return { ok: false, message: `${path}.domains must be an array` };
  }
  if (raw.domains.length === 0) {
    return { ok: false, message: `${path}.domains must include at least one domain` };
  }

  const domains: NormalizedDomain[] = [];
  for (let index = 0; index < raw.domains.length; index += 1) {
    const domain = normalizeDomain(raw.domains[index], `${path}.domains[${index}]`);
    if (!domain.ok) return domain;
    domains.push(domain.value);
  }

  return { ok: true, value: { stack: stack.value, domains } };
}

function normalizeInput(raw: unknown): NormalizeResult<NormalizedInput> {
  if (!isRecord(raw)) {
    return { ok: false, message: "input must be an object" };
  }
  const title = nonEmptyString(raw.title, "title");
  if (!title.ok) return title;
  const goal = nonEmptyString(raw.goal, "goal");
  if (!goal.ok) return goal;
  if (!Array.isArray(raw.stacks)) {
    return { ok: false, message: "stacks must be an array" };
  }
  if (raw.stacks.length === 0) {
    return { ok: false, message: "stacks must include at least one applicable stack" };
  }

  const stacks: NormalizedStack[] = [];
  const seenStacks = new Set<UltraPlanStackId>();
  for (let index = 0; index < raw.stacks.length; index += 1) {
    const stack = normalizeStack(raw.stacks[index], `stacks[${index}]`);
    if (!stack.ok) return stack;
    if (seenStacks.has(stack.value.stack)) {
      return { ok: false, message: `stacks[${index}].stack duplicates ${stack.value.stack}` };
    }
    seenStacks.add(stack.value.stack);
    stacks.push(stack.value);
  }

  return { ok: true, value: { title: title.value, goal: goal.value, stacks } };
}

function formatCatalogErrors(errors: readonly UltraPlanCatalogError[]): string {
  return errors.map((error) => error.message).join("; ");
}

function formatDraftOpError(error: DraftOpError): string {
  if (error.code === "duplicate-id") {
    return `duplicate ${error.where} id: ${error.id}`;
  }
  if (error.code === "not-found") {
    return `${error.where} not found: ${error.id}`;
  }
  if (error.code === "length-cap") {
    return `${error.field} is over length cap (${error.got}/${error.max})`;
  }
  if (error.code === "bad-applicability-transition") {
    return error.message;
  }
  return `${error.path} ${error.message}`;
}

function uniqueSlug(raw: string | undefined, fallback: string, used: Set<string>, maxLength: number): string {
  const seed = raw?.trim() || fallback;
  const base = slugifyUltraPlanId(seed, maxLength);
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    const append = `-${suffix}`;
    candidate = `${base.slice(0, Math.max(1, maxLength - append.length))}${append}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function applyDraftOp(result: ReturnType<typeof setStackApplicability>, context: string): UltraPlanAuthoringToolCreateResult | UltraPlanAuthoredDraft {
  if (result.ok) {
    return result.draft;
  }
  return { ok: false, message: `${context}: ${formatDraftOpError(result.reason)}`, details: result.reason };
}

function buildDraft(
  input: NormalizedInput,
  platform: Platform,
  cwd: string,
  deps: AuthoringDependencies,
): UltraPlanAuthoringToolCreateResult | UltraPlanAuthoredDraft {
  const catalogResult = deps.loadCatalog(platform.paths, cwd);
  if (!catalogResult.ok) {
    return {
      ok: false,
      message: `UltraPlan agent catalog is invalid: ${formatCatalogErrors(catalogResult.errors)}`,
      details: catalogResult.errors,
    };
  }

  const missing = collectMissingRequiredSlotErrors(catalogResult.value);
  if (missing.length > 0) {
    return {
      ok: false,
      message: `UltraPlan agent catalog is missing required slots: ${formatCatalogErrors(missing)}`,
      details: missing,
    };
  }

  let draft = buildInitialAuthoredDraft({
    sessionId: deps.newSessionId(),
    title: input.title,
    goal: input.goal,
    createdAt: deps.now(),
    catalog: catalogResult.value,
  });

  const applicableStacks = new Set(input.stacks.map((stack) => stack.stack));
  for (const stack of ULTRAPLAN_STACKS) {
    const result = setStackApplicability(draft, stack, applicableStacks.has(stack) ? "applicable" : "not-applicable");
    const next = applyDraftOp(result, `set ${stack} applicability`);
    if ("ok" in next) return next;
    draft = next;
  }

  for (const stackInput of input.stacks) {
    const usedDomainIds = new Set<string>();
    for (const domainInput of stackInput.domains) {
      const domainId = uniqueSlug(domainInput.id, domainInput.name, usedDomainIds, 32);
      const domainResult = addDomain(draft, stackInput.stack, { id: domainId, name: domainInput.name });
      const next = applyDraftOp(domainResult, `add ${stackInput.stack}.${domainId}`);
      if ("ok" in next) return next;
      draft = next;

      const usedScenarioIdsByLevel = new Map<UltraPlanScenarioLevel, Set<string>>(
        ULTRAPLAN_LEVELS.map((level) => [level, new Set<string>()]),
      );
      for (const scenarioInput of domainInput.scenarios) {
        const usedScenarioIds = usedScenarioIdsByLevel.get(scenarioInput.level)!;
        const scenarioId = uniqueSlug(scenarioInput.id, scenarioInput.title, usedScenarioIds, 48);
        const scenarioResult = addScenario(
          draft,
          { stack: stackInput.stack, domainId, level: scenarioInput.level },
          {
            id: scenarioId,
            title: scenarioInput.title,
            steps: scenarioInput.steps,
            dependencies: scenarioInput.dependencies,
          },
        );
        const afterScenario = applyDraftOp(
          scenarioResult,
          `add ${stackInput.stack}.${domainId}.${scenarioInput.level}.${scenarioId}`,
        );
        if ("ok" in afterScenario) return afterScenario;
        draft = afterScenario;
      }
    }
  }

  const readiness = isDraftReadyToPersist(draft);
  if (!readiness.ok) {
    return { ok: false, message: "UltraPlan draft is not ready to persist", details: readiness.blockers };
  }

  return draft;
}

function storageErrorMessage(error: UltraPlanStorageError): string {
  return `${error.message} (${error.path})`;
}

function persistDraft(
  draft: UltraPlanAuthoredDraft,
  platform: Platform,
  cwd: string,
  deps: AuthoringDependencies,
): UltraPlanAuthoringToolCreateResult {
  let current = draft;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const now = deps.now();
    const authored = draftToAuthoredArtifact(current, now);
    const manifest = draftToManifest(current, getUltraplanProjectName(cwd), now);
    const persistResult: AuthoringPersistResult = deps.persist({ paths: platform.paths, cwd, authored, manifest });
    if (persistResult.ok) {
      return {
        ok: true,
        sessionId: current.sessionId,
        title: current.title,
        goal: current.goal,
        authoredPath: persistResult.authoredPath,
        manifestPath: persistResult.manifestPath,
        indexPath: persistResult.indexPath,
        reclaimed: persistResult.reclaimed,
      };
    }

    if (persistResult.error.kind === "session-id-exists") {
      const rerolled = setSessionId(current, deps.newSessionId());
      if (!rerolled.ok) {
        return { ok: false, message: `reroll session id: ${formatDraftOpError(rerolled.reason)}`, details: rerolled.reason };
      }
      current = rerolled.draft;
      continue;
    }

    if (persistResult.error.kind === "index-invalid") {
      return {
        ok: false,
        message: `existing UltraPlan index is invalid: ${storageErrorMessage(persistResult.error.error)}`,
        details: persistResult.error.error,
      };
    }

    return {
      ok: false,
      message: `UltraPlan session could not be saved: ${storageErrorMessage(persistResult.error.error)}`,
      details: { error: persistResult.error.error, written: persistResult.error.written },
    };
  }

  return {
    ok: false,
    message: "session id collision after retry",
    details: { path: getUltraplanSessionDir(platform.paths, cwd, current.sessionId) },
  };
}

export function createUltraPlanFromAuthoringToolInput(input: {
  platform: Platform;
  cwd: string;
  params: unknown;
  deps?: Partial<AuthoringDependencies>;
}): UltraPlanAuthoringToolCreateResult {
  const normalized = normalizeInput(input.params);
  if (!normalized.ok) {
    return { ok: false, message: normalized.message };
  }

  const deps = { ...defaultDependencies(input.platform), ...input.deps };
  const draft = buildDraft(normalized.value, input.platform, input.cwd, deps);
  if ("ok" in draft) {
    return draft;
  }
  return persistDraft(draft, input.platform, input.cwd, deps);
}

function toolResult(result: UltraPlanAuthoringToolCreateResult) {
  if (!result.ok) {
    return {
      content: [{ type: "text", text: `Error: ${result.message}` }],
      error: true,
      details: result,
    };
  }

  return {
    content: [{
      type: "text",
      text: [
        `UltraPlan session saved: ${result.title} (${result.sessionId})`,
        `authored: ${result.authoredPath}`,
        `manifest: ${result.manifestPath}`,
        "Next: run `/supi:ultraplan run` to execute it.",
      ].join("\n"),
    }],
    details: result,
  };
}

const scenarioSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "Optional stable slug. Omit unless needed; duplicate slugs are suffixed." },
    title: { type: "string", description: "Concrete scenario title." },
    steps: { type: "array", items: { type: "string" }, description: "Optional implementation or verification notes." },
    dependencies: { type: "array", items: { type: "string" }, description: "Optional scenario ids this scenario depends on." },
  },
  required: ["title"],
} as const;

const scenarioWithLevelSchema = {
  type: "object",
  properties: {
    ...scenarioSchema.properties,
    level: { type: "string", enum: ULTRAPLAN_LEVELS, description: "Defaults to unit when omitted in the generic scenarios bucket." },
  },
  required: ["title"],
} as const;

export function registerUltraPlanAuthoringTool(platform: Platform): void {
  if (!platform.registerTool) {
    return;
  }

  platform.registerTool({
    name: "ultraplan_create",
    label: "UltraPlan Create",
    description: "Persist an UltraPlan session after refining a user's natural-language implementation goal.",
    promptSnippet: "ultraplan_create — save an inferred UltraPlan with title, goal, applicable stacks, domains, and scenarios",
    promptGuidelines: [
      "Use only after you understand the requested work well enough to define a runnable UltraPlan.",
      "Do not ask the user to provide JSON; infer the structure from chat and repository context.",
      "Include only stacks that have work: frontend, backend, and/or infrastructure.",
      "Every included stack needs at least one domain, and every domain needs at least one scenario.",
    ],
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short session title shown in the UltraPlan picker." },
        goal: { type: "string", description: "One-line user outcome or implementation goal." },
        stacks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              stack: { type: "string", enum: ULTRAPLAN_STACKS, description: "Applicable work stack." },
              domains: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", description: "Optional stable domain slug. Omit to derive from name." },
                    name: { type: "string", description: "Domain name, such as Authentication or Billing." },
                    unit: { type: "array", items: scenarioSchema, description: "Unit-level scenarios." },
                    integration: { type: "array", items: scenarioSchema, description: "Integration-level scenarios." },
                    e2e: { type: "array", items: scenarioSchema, description: "End-to-end scenarios." },
                    scenarios: { type: "array", items: scenarioWithLevelSchema, description: "Alternative mixed bucket; each item may specify level." },
                  },
                  required: ["name"],
                },
              },
            },
            required: ["stack", "domains"],
          },
        },
      },
      required: ["title", "goal", "stacks"],
    },
    async execute(_toolCallId: string, params: unknown, _signal: AbortSignal, _onUpdate: unknown, toolCtx: unknown) {
      const cwd = isRecord(toolCtx) && typeof toolCtx.cwd === "string" && toolCtx.cwd.trim()
        ? toolCtx.cwd
        : null;
      if (!cwd) {
        return toolResult({ ok: false, message: "ultraplan_create requires a tool context cwd" });
      }

      return toolResult(createUltraPlanFromAuthoringToolInput({ platform, cwd, params }));
    },
  });
}
