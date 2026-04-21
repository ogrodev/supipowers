import type { Platform, PlatformContext, PlatformPaths } from "../platform/types.js";
import type {
  ResolvedUltraPlanCatalog,
  UltraPlanAgentSlotName,
  UltraPlanApplicability,
  UltraPlanCatalogError,
  UltraPlanCatalogLoadResult,
  UltraPlanReviewerSlotName,
  UltraPlanStackId,
  UltraPlanStorageError,
} from "../types.js";
import { loadUltraPlanAgentCatalog } from "./agent-catalog.js";
import {
  addDomain,
  addScenario,
  buildInitialAuthoredDraft,
  draftToAuthoredArtifact,
  draftToManifest,
  isDraftReadyToPersist,
  removeDomain,
  removeScenario,
  renameDomain,
  renameScenario,
  setSessionId,
  setSessionTitleAndGoal,
  setStackApplicability,
  SESSION_GOAL_MAX,
  SESSION_TITLE_MAX,
  type UltraPlanAuthoredDraft,
} from "./authoring-draft.js";
import {
  persistAuthoredUltraPlanSession,
  type AuthoringPersistInput,
  type AuthoringPersistResult,
} from "./authoring-persist.js";
import { renderUltraPlanAuthoredDraft } from "./presenter.js";
import { getUltraplanProjectName, getUltraplanSessionDir } from "./project-paths.js";
import { ULTRAPLAN_STACKS } from "./contracts.js";

export interface AuthoringDependencies {
  now: () => Date;
  newSessionId: () => string;
  loadCatalog: (paths: PlatformPaths, cwd: string) => UltraPlanCatalogLoadResult;
  persist: (input: AuthoringPersistInput) => AuthoringPersistResult;
}

export type AuthoringFailure =
  | { kind: "no-ui" }
  | { kind: "catalog-error"; errors: UltraPlanCatalogError[] }
  | { kind: "cancelled" }
  | { kind: "discarded" }
  | { kind: "empty-session" }
  | { kind: "persist-failed"; error: UltraPlanStorageError; partial: string[] };

export type AuthoringResult =
  | {
    ok: true;
    sessionId: string;
    paths: { authored: string; manifest: string; indexEntry: string };
  }
  | { ok: false; failure: AuthoringFailure };

function generateSessionId(now: Date): string {
  const yyyymmdd = now.toISOString().slice(0, 10).replace(/-/g, "");
  const random = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  return `ultraplan-${yyyymmdd}-${random}`;
}

export function defaultDependencies(_platform: Platform): AuthoringDependencies {
  return {
    now: () => new Date(),
    newSessionId: () => generateSessionId(new Date()),
    loadCatalog: loadUltraPlanAgentCatalog,
    persist: persistAuthoredUltraPlanSession,
  };
}

function mergeDependencies(
  platform: Platform,
  overrides: Partial<AuthoringDependencies> | undefined,
): AuthoringDependencies {
  return { ...defaultDependencies(platform), ...overrides };
}

function collectMissingRequiredSlotErrors(catalog: ResolvedUltraPlanCatalog): UltraPlanCatalogError[] {
  const errors: UltraPlanCatalogError[] = [];
  for (const stack of ULTRAPLAN_STACKS) {
    const executorSlot: UltraPlanAgentSlotName = `${stack}-executor`;
    const testerSlot: UltraPlanAgentSlotName = `${stack}-tester`;
    if (!catalog.slots[executorSlot]) {
      errors.push({
        slot: executorSlot,
        code: "required-slot-unresolved",
        message: `UltraPlan slot "${executorSlot}" is unresolved.`,
        path: null,
      });
    }
    if (!catalog.slots[testerSlot]) {
      errors.push({
        slot: testerSlot,
        code: "required-slot-unresolved",
        message: `UltraPlan slot "${testerSlot}" is unresolved.`,
        path: null,
      });
    }
    for (const suffix of ["domain-reviewer", "stack-reviewer"] as const) {
      const reviewer = `${stack}-${suffix}` as UltraPlanReviewerSlotName;
      const gateEnabled = catalog.reviewGates[reviewer]?.enabled ?? true;
      if (gateEnabled && !catalog.slots[reviewer]) {
        errors.push({
          slot: reviewer,
          code: "required-slot-unresolved",
          message: `UltraPlan slot "${reviewer}" is unresolved while its review gate is enabled.`,
          path: null,
        });
      }
    }
  }
  return errors;
}

async function promptBounded(
  ctx: PlatformContext,
  label: string,
  max: number,
  inputOpts: { placeholder?: string; helpText?: string } = {},
): Promise<string | null> {
  while (true) {
    const value = await ctx.ui.input(label, inputOpts);
    if (value === null) return null;
    if (value === "") {
      ctx.ui.notify(`${label}: must not be empty`, "warning");
      continue;
    }
    const len = [...value].length;
    if (len > max) {
      ctx.ui.notify(`${label}: over length cap (${len}/${max})`, "warning");
      continue;
    }
    return value;
  }
}

async function promptStackApplicability(
  ctx: PlatformContext,
  stack: UltraPlanStackId,
): Promise<UltraPlanApplicability | null> {
  const selected = await ctx.ui.select(`${stack} applicability`, ["applicable", "not-applicable"], {
    helpText: `Does this ultraplan include ${stack} work?`,
  });
  if (selected === null) return null;
  return selected === "not-applicable" ? "not-applicable" : "applicable";
}

export async function runUltraPlanAuthoringWizard(
  platform: Platform,
  ctx: PlatformContext,
  overrides?: Partial<AuthoringDependencies>,
): Promise<AuthoringResult> {
  if (!ctx.hasUI) {
    return { ok: false, failure: { kind: "no-ui" } };
  }

  const deps = mergeDependencies(platform, overrides);
  const catalogResult = deps.loadCatalog(platform.paths, ctx.cwd);
  if (!catalogResult.ok) {
    return { ok: false, failure: { kind: "catalog-error", errors: catalogResult.errors } };
  }

  const missing = collectMissingRequiredSlotErrors(catalogResult.value);
  if (missing.length > 0) {
    return { ok: false, failure: { kind: "catalog-error", errors: missing } };
  }

  // Phases 1–2: title + goal
  const title = await promptBounded(ctx, "Ultraplan title", SESSION_TITLE_MAX, {
    placeholder: "e.g. checkout-redesign",
    helpText: "Short name used in the session picker",
  });
  if (title === null) return { ok: false, failure: { kind: "cancelled" } };

  const goal = await promptBounded(ctx, "One-line goal", SESSION_GOAL_MAX, {
    placeholder: "e.g. Users can complete checkout on mobile",
  });
  if (goal === null) return { ok: false, failure: { kind: "cancelled" } };

  const initialDraft: UltraPlanAuthoredDraft = buildInitialAuthoredDraft({
    sessionId: deps.newSessionId(),
    title,
    goal,
    createdAt: deps.now(),
    catalog: catalogResult.value,
  });

  // Phase 3: stack applicability loop. Require at least one applicable stack.
  let draft = initialDraft;
  while (true) {
    let anyApplicable = false;
    for (const stack of ULTRAPLAN_STACKS) {
      const applicability = await promptStackApplicability(ctx, stack);
      if (applicability === null) {
        return { ok: false, failure: { kind: "cancelled" } };
      }
      const updated = setStackApplicability(draft, stack, applicability);
      if (!updated.ok) {
        // Shouldn't happen in practice — the set is total over valid stacks.
        return { ok: false, failure: { kind: "cancelled" } };
      }
      draft = updated.draft;
      if (applicability === "applicable") anyApplicable = true;
    }
    if (anyApplicable) break;
    ctx.ui.notify("At least one stack must be applicable", "warning");
  }

  // Phase 4 + 5: per-stack domain loop + per-domain scenario loop.
  for (const stack of draft.stacks) {
    if (stack.applicability !== "applicable") continue;
    const afterPhase4 = await runDomainLoop(ctx, draft, stack.stack, deps);
    if (afterPhase4 === null) return { ok: false, failure: { kind: "cancelled" } };
    draft = afterPhase4;

    const stackAfter = draft.stacks.find((s) => s.stack === stack.stack)!;
    for (const domain of stackAfter.domains) {
      const afterPhase5 = await runScenariosLoop(ctx, draft, stack.stack, domain.id, deps);
      if (afterPhase5 === null) return { ok: false, failure: { kind: "cancelled" } };
      draft = afterPhase5;
    }
  }
  // Phase 6: review loop
  while (true) {
    const reviewResult = await runReviewLoop(ctx, draft, deps);
    if (reviewResult.kind === "approved") {
      draft = reviewResult.draft;
      break;
    }
    if (reviewResult.kind === "cancelled") return { ok: false, failure: { kind: "cancelled" } };
    if (reviewResult.kind === "discarded") return { ok: false, failure: { kind: "discarded" } };
    draft = reviewResult.draft;
  }

  // Phase 7: persist.
  return runPersist(platform, ctx, draft, deps);
}



const DOMAIN_NAME_MAX = 60;

function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining diacritics
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "domain";
}

async function runDomainLoop(
  ctx: PlatformContext,
  draft: UltraPlanAuthoredDraft,
  stackId: UltraPlanStackId,
  _deps: AuthoringDependencies,
): Promise<UltraPlanAuthoredDraft | null> {
  let current = draft;

  while (true) {
    const stack = current.stacks.find((s) => s.stack === stackId)!;
    const options = [
      "+ Add domain",
      ...stack.domains.map((d) => `✎ Rename ${d.id}`),
      ...stack.domains.map((d) => `− Remove ${d.id}`),
      `✓ Done with ${stackId} domains`,
    ];
    const selected = await ctx.ui.select(`${stackId} domains`, options, {
      helpText: "Domains group related scenarios. Each must carry ≥1 scenario.",
    });
    if (selected === null) return null;

    if (selected === "+ Add domain") {
      const name = await promptBounded(ctx, `Name for the new ${stackId} domain`, DOMAIN_NAME_MAX);
      if (name === null) return null;
      const id = slugify(name);
      const result = addDomain(current, stackId, { id, name });
      if (!result.ok) {
        if (result.reason.code === "duplicate-id") {
          ctx.ui.notify(`duplicate domain id: ${id}`, "warning");
        } else {
          ctx.ui.notify(`could not add domain: ${result.reason.code}`, "warning");
        }
        continue;
      }
      current = result.draft;
      continue;
    }

    const renameMatch = /^✎ Rename (.+)$/.exec(selected);
    if (renameMatch) {
      const domainId = renameMatch[1];
      const newName = await promptBounded(ctx, `New name for ${domainId}`, DOMAIN_NAME_MAX);
      if (newName === null) return null;
      const result = renameDomain(current, stackId, domainId, { name: newName });
      if (!result.ok) {
        ctx.ui.notify(`could not rename: ${result.reason.code}`, "warning");
        continue;
      }
      current = result.draft;
      continue;
    }

    const removeMatch = /^− Remove (.+)$/.exec(selected);
    if (removeMatch) {
      const domainId = removeMatch[1];
      const confirmed = await confirmDestructive(ctx, "Remove domain?", `Remove ${domainId} and its scenarios?`);
      if (!confirmed) continue;
      const result = removeDomain(current, stackId, domainId);
      if (!result.ok) {
        ctx.ui.notify(`could not remove: ${result.reason.code}`, "warning");
        continue;
      }
      current = result.draft;
      continue;
    }

    if (selected === `✓ Done with ${stackId} domains`) {
      if (stack.domains.length === 0) {
        ctx.ui.notify(`${stackId} must have at least one domain`, "warning");
        continue;
      }
      return current;
    }
  }
}

async function confirmDestructive(
  ctx: PlatformContext,
  title: string,
  message: string,
  opts: { keep?: string; yes?: string } = {},
): Promise<boolean> {
  if (ctx.ui.confirm) {
    return ctx.ui.confirm(title, message);
  }
  const yes = opts.yes ?? "Yes, remove";
  const keep = opts.keep ?? "Keep";
  const answer = await ctx.ui.select(title, [keep, yes]);
  return answer === yes;
}

const SCENARIO_TITLE_MAX_LOCAL = 120;
const LEVELS_ORDER: readonly ("unit" | "integration" | "e2e")[] = ["unit", "integration", "e2e"];

async function runScenariosLoop(
  ctx: PlatformContext,
  draft: UltraPlanAuthoredDraft,
  stackId: UltraPlanStackId,
  domainId: string,
  _deps: AuthoringDependencies,
): Promise<UltraPlanAuthoredDraft | null> {
  let current = draft;

  while (true) {
    for (const level of LEVELS_ORDER) {
      const next = await runScenarioLevelLoop(ctx, current, stackId, domainId, level);
      if (next === null) return null;
      current = next;
    }
    const domain = current.stacks.find((s) => s.stack === stackId)?.domains.find((d) => d.id === domainId);
    if (!domain) return current;
    const total = domain.unit.length + domain.integration.length + domain.e2e.length;
    if (total > 0) return current;
    ctx.ui.notify(`${stackId}.${domainId} must have at least one scenario`, "warning");
  }
}

async function runScenarioLevelLoop(
  ctx: PlatformContext,
  draft: UltraPlanAuthoredDraft,
  stackId: UltraPlanStackId,
  domainId: string,
  level: "unit" | "integration" | "e2e",
): Promise<UltraPlanAuthoredDraft | null> {
  let current = draft;
  while (true) {
    const domain = current.stacks.find((s) => s.stack === stackId)?.domains.find((d) => d.id === domainId);
    if (!domain) return current;
    const scenarios = domain[level];
    const options = [
      `+ Add ${level} scenario`,
      ...scenarios.map((s) => `✎ Rename ${s.id}`),
      ...scenarios.map((s) => `− Remove ${s.id}`),
      `✓ Done with ${level}`,
    ];
    const selected = await ctx.ui.select(
      `${stackId} / ${domainId} / ${level}`,
      options,
    );
    if (selected === null) return null;

    if (selected === `+ Add ${level} scenario`) {
      const title = await promptBounded(ctx, `Title for the new ${level} scenario`, SCENARIO_TITLE_MAX_LOCAL);
      if (title === null) return null;
      const id = slugify(title);
      const result = addScenario(current, { stack: stackId, domainId, level }, { id, title });
      if (!result.ok) {
        if (result.reason.code === "duplicate-id") {
          ctx.ui.notify(`duplicate scenario id: ${id}`, "warning");
        } else {
          ctx.ui.notify(`could not add scenario: ${result.reason.code}`, "warning");
        }
        continue;
      }
      current = result.draft;
      continue;
    }

    const renameMatch = /^✎ Rename (.+)$/.exec(selected);
    if (renameMatch) {
      const scenarioId = renameMatch[1];
      const newTitle = await promptBounded(ctx, `New title for ${scenarioId}`, SCENARIO_TITLE_MAX_LOCAL);
      if (newTitle === null) return null;
      const result = renameScenario(current, { stack: stackId, domainId, level, scenarioId }, { title: newTitle });
      if (!result.ok) {
        ctx.ui.notify(`could not rename: ${result.reason.code}`, "warning");
        continue;
      }
      current = result.draft;
      continue;
    }

    const removeMatch = /^− Remove (.+)$/.exec(selected);
    if (removeMatch) {
      const scenarioId = removeMatch[1];
      const confirmed = await confirmDestructive(ctx, "Remove scenario?", `Remove ${scenarioId}?`);
      if (!confirmed) continue;
      const result = removeScenario(current, { stack: stackId, domainId, level, scenarioId });
      if (!result.ok) {
        ctx.ui.notify(`could not remove: ${result.reason.code}`, "warning");
        continue;
      }
      current = result.draft;
      continue;
    }

    if (selected === `✓ Done with ${level}`) {
      return current;
    }
  }
}

type ReviewOutcome =
  | { kind: "approved"; draft: UltraPlanAuthoredDraft }
  | { kind: "cancelled" }
  | { kind: "discarded" }
  | { kind: "edited"; draft: UltraPlanAuthoredDraft };

async function runReviewLoop(
  ctx: PlatformContext,
  draft: UltraPlanAuthoredDraft,
  deps: AuthoringDependencies,
): Promise<ReviewOutcome> {
  const readiness = isDraftReadyToPersist(draft);
  const reviewLines = renderUltraPlanAuthoredDraft(draft);
  const options: string[] = [];
  if (readiness.ok) options.push("✓ Approve & save");
  options.push("✎ Edit title & goal");
  for (const stack of draft.stacks) {
    options.push(`✎ Edit ${stack.stack}.applicability`);
    for (const domain of stack.domains) {
      options.push(`✎ Edit ${stack.stack}.${domain.id}`);
      options.push(`✎ Edit ${stack.stack}.${domain.id}.scenarios`);
    }
  }
  options.push("✗ Discard");

  const selected = await ctx.ui.select(reviewLines.join("\n"), options);
  if (selected === null) return { kind: "cancelled" };

  if (selected === "✓ Approve & save") {
    return { kind: "approved", draft };
  }
  if (selected === "✎ Edit title & goal") {
    const title = await promptBounded(ctx, "Ultraplan title", SESSION_TITLE_MAX, {
      placeholder: draft.title,
    });
    if (title === null) return { kind: "edited", draft };
    const goal = await promptBounded(ctx, "One-line goal", SESSION_GOAL_MAX, {
      placeholder: draft.goal,
    });
    if (goal === null) return { kind: "edited", draft };
    const updated = setSessionTitleAndGoal(draft, { title, goal });
    return { kind: "edited", draft: updated.ok ? updated.draft : draft };
  }

  const applicabilityMatch = /^✎ Edit (.+)\.applicability$/.exec(selected);
  if (applicabilityMatch) {
    const stackId = applicabilityMatch[1] as UltraPlanStackId;
    const applicability = await promptStackApplicability(ctx, stackId);
    if (applicability === null) return { kind: "edited", draft };
    const current = draft.stacks.find((s) => s.stack === stackId)!;
    const isDestructive = current.applicability === "applicable" && applicability === "not-applicable" && current.domains.length > 0;
    if (isDestructive) {
      const scenarioCount = current.domains.reduce((acc, d) => acc + d.unit.length + d.integration.length + d.e2e.length, 0);
      const confirmed = await confirmDestructive(
        ctx,
        `${stackId} will lose ${current.domains.length} domain(s) and ${scenarioCount} scenario(s). Continue?`,
        `Change ${stackId} applicability`,
        { keep: "Keep", yes: "Yes, change" },
      );
      if (!confirmed) return { kind: "edited", draft };
    }
    const updated = setStackApplicability(draft, stackId, applicability);
    return { kind: "edited", draft: updated.ok ? updated.draft : draft };
  }

  const scenariosMatch = /^✎ Edit (.+)\.(.+)\.scenarios$/.exec(selected);
  if (scenariosMatch) {
    const stackId = scenariosMatch[1] as UltraPlanStackId;
    const domainId = scenariosMatch[2];
    const next = await runScenariosLoop(ctx, draft, stackId, domainId, deps);
    return next === null ? { kind: "cancelled" } : { kind: "edited", draft: next };
  }

  const domainMatch = /^✎ Edit (.+)\.(.+)$/.exec(selected);
  if (domainMatch) {
    const stackId = domainMatch[1] as UltraPlanStackId;
    const next = await runDomainLoop(ctx, draft, stackId, deps);
    return next === null ? { kind: "cancelled" } : { kind: "edited", draft: next };
  }

  if (selected === "✗ Discard") {
    const confirmed = await confirmDestructive(ctx, "Discard?", "No files have been written yet. Throw away this draft?", { keep: "Keep editing", yes: "Yes, discard" });
    return confirmed ? { kind: "discarded" } : { kind: "edited", draft };
  }

  return { kind: "edited", draft };
}

async function runPersist(
  platform: Platform,
  ctx: PlatformContext,
  initialDraft: UltraPlanAuthoredDraft,
  deps: AuthoringDependencies,
): Promise<AuthoringResult> {
  let draft = initialDraft;
  let attempts = 0;
  while (true) {
    attempts += 1;
    const authored = draftToAuthoredArtifact(draft, deps.now());
    const projectName = getUltraplanProjectName(ctx.cwd);
    const manifest = draftToManifest(draft, projectName, deps.now());
    const persistResult = deps.persist({ paths: platform.paths, cwd: ctx.cwd, authored, manifest });
    if (persistResult.ok) {
      if (persistResult.reclaimed) {
        ctx.ui.notify("Cleaning up prior aborted session id", "info");
      }
      ctx.ui.notify(`Ultraplan session '${draft.title}' saved (${draft.sessionId})`, "info");
      return {
        ok: true,
        sessionId: draft.sessionId,
        paths: {
          authored: persistResult.authoredPath,
          manifest: persistResult.manifestPath,
          indexEntry: persistResult.indexPath,
        },
      };
    }
    if (persistResult.error.kind === "session-id-exists") {
      if (attempts >= 2) {
        const synthesized: UltraPlanStorageError = {
          kind: "io",
          path: getUltraplanSessionDir(platform.paths, ctx.cwd, draft.sessionId),
          message: "session id collision after retry",
        };
        return { ok: false, failure: { kind: "persist-failed", error: synthesized, partial: [] } };
      }
      const reroll = setSessionId(draft, deps.newSessionId());
      if (!reroll.ok) {
        return { ok: false, failure: { kind: "cancelled" } };
      }
      draft = reroll.draft;
      continue;
    }
    if (persistResult.error.kind === "index-invalid") {
      ctx.ui.notify(`Persist failed: existing ultraplan index.json is invalid (${persistResult.error.error.message})`, "error");
      return { ok: false, failure: { kind: "persist-failed", error: persistResult.error.error, partial: [] } };
    }
    if (persistResult.error.kind === "storage-error") {
      ctx.ui.notify(`Persist failed: ${persistResult.error.error.message}`, "error");
      return { ok: false, failure: { kind: "persist-failed", error: persistResult.error.error, partial: persistResult.error.written } };
    }
    return { ok: false, failure: { kind: "cancelled" } };
  }
}