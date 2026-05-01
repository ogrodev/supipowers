/**
 * Authoring-pipeline tool registrations.
 *
 * Every stage in the multi-stage pipeline emits its artifact via a dedicated tool that the
 * spawned sub-agent calls. The tools are thin wrappers: they validate the JSON payload
 * against the relevant TypeBox schema and persist it atomically through `authoring/storage`.
 *
 * Why one tool per stage instead of a single `ultraplan_authoring_record({ stage, ... })`?
 *  - Each stage has a different payload shape; one tool per stage keeps the JSON schema
 *    advertised to the model tightly scoped, which materially improves tool-call quality.
 *  - The hook bridge can correlate by tool name alone, no ambient discriminator needed.
 *  - Future stages can ship their own tool without rev'ing the existing schema.
 *
 * Registration is idempotent at the harness boundary: if `platform.registerTool` is missing
 * (legacy harness) we silently no-op. The pipeline driver expects these tools to be
 * registered at extension load and stays out of registration concerns.
 */

import type { Platform } from "../../platform/types.js";
import type {
  UltraPlanAuthoringFinding,
  UltraPlanStackId,
  UltraPlanStorageResult,
} from "../../types.js";
import { ULTRAPLAN_STACKS } from "../contracts.js";
import {
  appendDecisionRecord,
  loadDeferredIdeas,
  loadFindingsArtifact,
  saveDeferredIdeas,
  saveDraftAuthoredJson,
  saveDraftPlannerJson,
  saveFindingsArtifact,
  saveIntakeArtifact,
  saveResearchStackArtifact,
  saveResearchSummary,
  saveScoutArtifact,
} from "./storage.js";

// ---------------------------------------------------------------------------
// Helpers shared across tool registrations
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ToolReturn {
  ok: boolean;
  message?: string;
  path?: string;
  details?: unknown;
}

function toolResult(payload: ToolReturn): { ok: boolean; message?: string; path?: string; details?: unknown } {
  return payload;
}

/**
 * Reject session ids that could escape the intended UltraPlan session directory when joined
 * with `path.join(...)`. Authoring tools accept the id from agent-supplied tool params, so a
 * rogue or malformed call must not be able to write artifacts outside the session.
 *
 * Allowed: short ASCII slug — letters, digits, dot (mid-string), underscore, hyphen.
 * Disallowed: empty/whitespace, leading dot, path separators, parent-segment patterns,
 * absolute paths, NUL bytes, anything longer than 128 chars.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?$/;

function isSafeSessionId(value: string): boolean {
  if (!SESSION_ID_PATTERN.test(value)) return false;
  if (value.includes("..")) return false;
  return true;
}

function readSessionId(params: unknown, toolName: string): { ok: true; sessionId: string } | { ok: false; message: string } {
  if (!isRecord(params)) {
    return { ok: false, message: `${toolName} requires an object payload` };
  }
  const raw = params.sessionId;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, message: `${toolName} requires a sessionId string` };
  }
  if (!isSafeSessionId(raw)) {
    return {
      ok: false,
      message: `${toolName} rejected sessionId: must match ${SESSION_ID_PATTERN} and contain no '..' segments`,
    };
  }
  return { ok: true, sessionId: raw };
}

function readCwd(toolCtx: unknown, toolName: string): { ok: true; cwd: string } | { ok: false; message: string } {
  if (isRecord(toolCtx) && typeof toolCtx.cwd === "string" && toolCtx.cwd.trim().length > 0) {
    return { ok: true, cwd: toolCtx.cwd };
  }
  return { ok: false, message: `${toolName} requires a tool context cwd` };
}

function unwrap<T>(result: UltraPlanStorageResult<T>, toolName: string): { ok: true; value: T; path?: string } | { ok: false; message: string } {
  if (result.ok) {
    return { ok: true, value: result.value, path: typeof result.value === "string" ? (result.value as string) : undefined };
  }
  const detail = result.error.details && result.error.details.length > 0 ? `: ${result.error.details.join(", ")}` : "";
  return { ok: false, message: `${toolName} storage error (${result.error.kind}) at ${result.error.path}${detail}: ${result.error.message}` };
}

// ---------------------------------------------------------------------------
// Schema fragments reused across multiple tools
// ---------------------------------------------------------------------------

const SESSION_ID_PROP = {
  type: "string",
  description: "UltraPlan session id; assigned by the pipeline runner and passed through the agent prompt.",
} as const;

const STACK_ENUM = {
  type: "string",
  enum: ULTRAPLAN_STACKS,
  description: "Stack identifier (frontend / backend / infrastructure).",
} as const;

const FINDING_TARGET = {
  type: "object",
  properties: {
    stack: { type: ["string", "null"], enum: [...ULTRAPLAN_STACKS, null] },
    domainId: { type: ["string", "null"] },
    scenarioId: { type: ["string", "null"] },
  },
  required: ["stack", "domainId", "scenarioId"],
} as const;

// ---------------------------------------------------------------------------
// Public registration entry point
// ---------------------------------------------------------------------------

/**
 * Register every authoring tool with the harness. Safe to call once at extension boot —
 * subsequent calls would throw at the harness layer (each tool name registers exactly once).
 *
 * Stage tools registered:
 *  - ultraplan_intake_record
 *  - ultraplan_scout_record
 *  - ultraplan_decision_record
 *  - ultraplan_defer_idea
 *  - ultraplan_research_record
 *  - ultraplan_research_summary
 *  - ultraplan_synth_draft
 *  - ultraplan_review_finding
 *  - ultraplan_revise_apply
 */
export function registerUltraPlanAuthoringPipelineTools(platform: Platform): void {
  if (!platform.registerTool) return;

  // -------- ultraplan_intake_record ----------
  platform.registerTool({
    name: "ultraplan_intake_record",
    label: "UltraPlan Intake Record",
    description: "Record the intake stage artifact for an UltraPlan authoring session.",
    parameters: {
      type: "object",
      properties: {
        sessionId: SESSION_ID_PROP,
        title: { type: "string", description: "Short session title shown in the picker." },
        goal: { type: "string", description: "One-line implementation goal." },
        candidateStacks: {
          type: "array",
          description: "Per-stack applicability hints; downstream stages refine these.",
          items: {
            type: "object",
            properties: {
              stack: STACK_ENUM,
              applicability: { type: "string", enum: ["applicable", "not-applicable"] },
              note: { type: "string" },
            },
            required: ["stack", "applicability"],
          },
        },
        rawUserNotes: { type: "string", description: "Verbatim seed prompt or pasted user notes for forensics." },
        deferredIdeas: { type: "array", items: { type: "string" } },
      },
      required: ["sessionId", "title", "goal", "candidateStacks"],
    },
    async execute(_id: string, params: unknown, _signal: AbortSignal, _onUpdate: unknown, toolCtx: unknown) {
      const cwdR = readCwd(toolCtx, "ultraplan_intake_record");
      if (!cwdR.ok) return toolResult(cwdR);
      const sidR = readSessionId(params, "ultraplan_intake_record");
      if (!sidR.ok) return toolResult(sidR);

      const persisted = saveIntakeArtifact(platform.paths, cwdR.cwd, sidR.sessionId, params);
      const result = unwrap(persisted, "ultraplan_intake_record");
      if (!result.ok) return toolResult(result);
      return toolResult({ ok: true, path: result.value });
    },
  });

  // -------- ultraplan_scout_record ----------
  platform.registerTool({
    name: "ultraplan_scout_record",
    label: "UltraPlan Scout Record",
    description: "Record the scout stage artifact (codebase reconnaissance).",
    parameters: {
      type: "object",
      properties: {
        sessionId: SESSION_ID_PROP,
        reusableAssets: {
          type: "array",
          description: "File paths or symbol references the implementation can reuse.",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", description: "asset|module|function|test|config" },
              path: { type: "string" },
              note: { type: "string" },
            },
            required: ["kind", "path"],
          },
        },
        integrationPoints: {
          type: "array",
          description: "Existing modules the new work needs to integrate with.",
          items: {
            type: "object",
            properties: { path: { type: "string" }, note: { type: "string" } },
            required: ["path"],
          },
        },
        conventionsByStack: {
          type: "object",
          description: "Conventions grouped by stack id.",
          properties: {
            frontend: { type: "array", items: { type: "string" } },
            backend: { type: "array", items: { type: "string" } },
            infrastructure: { type: "array", items: { type: "string" } },
          },
        },
        existingTests: { type: "array", items: { type: "string" } },
      },
      required: ["sessionId"],
    },
    async execute(_id: string, params: unknown, _signal: AbortSignal, _onUpdate: unknown, toolCtx: unknown) {
      const cwdR = readCwd(toolCtx, "ultraplan_scout_record");
      if (!cwdR.ok) return toolResult(cwdR);
      const sidR = readSessionId(params, "ultraplan_scout_record");
      if (!sidR.ok) return toolResult(sidR);

      const persisted = saveScoutArtifact(platform.paths, cwdR.cwd, sidR.sessionId, params);
      const result = unwrap(persisted, "ultraplan_scout_record");
      if (!result.ok) return toolResult(result);
      return toolResult({ ok: true, path: result.value });
    },
  });

  // -------- ultraplan_decision_record ----------
  platform.registerTool({
    name: "ultraplan_decision_record",
    label: "UltraPlan Decision Record",
    description: "Append one decision (locked answer to a gray-area question) to the discuss artifact.",
    parameters: {
      type: "object",
      properties: {
        sessionId: SESSION_ID_PROP,
        area: { type: "string", description: "Short label for the decision area (e.g. 'auth-strategy')." },
        question: { type: "string", description: "The exact gray-area question that was answered." },
        decision: { type: "string", description: "The locked answer." },
        rationale: { type: "string", description: "Why this decision was chosen." },
        impact: { type: "array", items: { type: "string" }, description: "Domains/scenarios this decision affects." },
      },
      required: ["sessionId", "area", "question", "decision"],
    },
    async execute(_id: string, params: unknown, _signal: AbortSignal, _onUpdate: unknown, toolCtx: unknown) {
      const cwdR = readCwd(toolCtx, "ultraplan_decision_record");
      if (!cwdR.ok) return toolResult(cwdR);
      const sidR = readSessionId(params, "ultraplan_decision_record");
      if (!sidR.ok) return toolResult(sidR);

      // Decisions are written line-by-line as JSONL. The discuss.md aggregation happens at
      // discover-stage commit time (the user gate).
      const recordedAt = new Date().toISOString();
      const decision = { ...(params as Record<string, unknown>), recordedAt };
      const persisted = appendDecisionRecord(platform.paths, cwdR.cwd, sidR.sessionId, decision);
      const result = unwrap(persisted, "ultraplan_decision_record");
      if (!result.ok) return toolResult(result);
      return toolResult({ ok: true, path: result.value });
    },
  });

  // -------- ultraplan_defer_idea ----------
  platform.registerTool({
    name: "ultraplan_defer_idea",
    label: "UltraPlan Defer Idea",
    description: "Append an idea to deferred-ideas.md so the discover stage stays scoped.",
    parameters: {
      type: "object",
      properties: {
        sessionId: SESSION_ID_PROP,
        idea: { type: "string", description: "One-line description of the idea being deferred." },
        reason: { type: "string", description: "Why it is out of scope for this session." },
      },
      required: ["sessionId", "idea"],
    },
    async execute(_id: string, params: unknown, _signal: AbortSignal, _onUpdate: unknown, toolCtx: unknown) {
      const cwdR = readCwd(toolCtx, "ultraplan_defer_idea");
      if (!cwdR.ok) return toolResult(cwdR);
      const sidR = readSessionId(params, "ultraplan_defer_idea");
      if (!sidR.ok) return toolResult(sidR);

      const p = params as Record<string, unknown>;
      const idea = typeof p.idea === "string" ? p.idea : "";
      const reason = typeof p.reason === "string" ? p.reason : "";
      if (idea.length === 0) return toolResult({ ok: false, message: "ultraplan_defer_idea requires a non-empty idea" });

      // Append (load + concat + save) — avoids overwriting prior ideas on re-runs.
      const prior = loadDeferredIdeas(platform.paths, cwdR.cwd, sidR.sessionId);
      const existing = prior.ok ? prior.value : "";
      const next = `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}- ${idea}${reason ? ` — ${reason}` : ""}\n`;
      const persisted = saveDeferredIdeas(platform.paths, cwdR.cwd, sidR.sessionId, next);
      const result = unwrap(persisted, "ultraplan_defer_idea");
      if (!result.ok) return toolResult(result);
      return toolResult({ ok: true, path: result.value });
    },
  });

  // -------- ultraplan_research_record ----------
  platform.registerTool({
    name: "ultraplan_research_record",
    label: "UltraPlan Research Record",
    description: "Record per-stack research findings (libraries, patterns, pitfalls).",
    parameters: {
      type: "object",
      properties: {
        sessionId: SESSION_ID_PROP,
        stack: STACK_ENUM,
        markdown: {
          type: "string",
          description: "Full markdown body for this stack's research artifact.",
        },
      },
      required: ["sessionId", "stack", "markdown"],
    },
    async execute(_id: string, params: unknown, _signal: AbortSignal, _onUpdate: unknown, toolCtx: unknown) {
      const cwdR = readCwd(toolCtx, "ultraplan_research_record");
      if (!cwdR.ok) return toolResult(cwdR);
      const sidR = readSessionId(params, "ultraplan_research_record");
      if (!sidR.ok) return toolResult(sidR);

      const p = params as Record<string, unknown>;
      const stack = p.stack as UltraPlanStackId;
      const markdown = typeof p.markdown === "string" ? p.markdown : "";
      if (!ULTRAPLAN_STACKS.includes(stack)) {
        return toolResult({ ok: false, message: `ultraplan_research_record stack must be one of ${ULTRAPLAN_STACKS.join(", ")}` });
      }
      if (markdown.length === 0) {
        return toolResult({ ok: false, message: "ultraplan_research_record markdown must be non-empty" });
      }

      const persisted = saveResearchStackArtifact(platform.paths, cwdR.cwd, sidR.sessionId, stack, markdown);
      const result = unwrap(persisted, "ultraplan_research_record");
      if (!result.ok) return toolResult(result);
      return toolResult({ ok: true, path: result.value });
    },
  });

  // -------- ultraplan_research_summary ----------
  platform.registerTool({
    name: "ultraplan_research_summary",
    label: "UltraPlan Research Summary",
    description: "Persist the per-session research summary that consolidates per-stack findings.",
    parameters: {
      type: "object",
      properties: {
        sessionId: SESSION_ID_PROP,
        markdown: { type: "string" },
      },
      required: ["sessionId", "markdown"],
    },
    async execute(_id: string, params: unknown, _signal: AbortSignal, _onUpdate: unknown, toolCtx: unknown) {
      const cwdR = readCwd(toolCtx, "ultraplan_research_summary");
      if (!cwdR.ok) return toolResult(cwdR);
      const sidR = readSessionId(params, "ultraplan_research_summary");
      if (!sidR.ok) return toolResult(sidR);

      const md = (params as Record<string, unknown>).markdown;
      if (typeof md !== "string" || md.length === 0) {
        return toolResult({ ok: false, message: "ultraplan_research_summary requires non-empty markdown" });
      }
      const persisted = saveResearchSummary(platform.paths, cwdR.cwd, sidR.sessionId, md);
      const result = unwrap(persisted, "ultraplan_research_summary");
      if (!result.ok) return toolResult(result);
      return toolResult({ ok: true, path: result.value });
    },
  });

  // -------- ultraplan_synth_draft ----------
  platform.registerTool({
    name: "ultraplan_synth_draft",
    label: "UltraPlan Synth Draft",
    description: "Persist the synthesizer's authored.json + manifest.json draft for the given iteration.",
    parameters: {
      type: "object",
      properties: {
        sessionId: SESSION_ID_PROP,
        iteration: { type: "integer", minimum: 1 },
        authored: { type: "object", description: "Full authored.json payload (UltraPlanAuthoredArtifact shape)." },
        manifest: { type: "object", description: "Full manifest.json payload (UltraPlanManifest shape)." },
      },
      required: ["sessionId", "iteration", "authored", "manifest"],
    },
    async execute(_id: string, params: unknown, _signal: AbortSignal, _onUpdate: unknown, toolCtx: unknown) {
      const cwdR = readCwd(toolCtx, "ultraplan_synth_draft");
      if (!cwdR.ok) return toolResult(cwdR);
      const sidR = readSessionId(params, "ultraplan_synth_draft");
      if (!sidR.ok) return toolResult(sidR);

      const p = params as Record<string, unknown>;
      const iteration = typeof p.iteration === "number" ? p.iteration : 0;
      if (!Number.isInteger(iteration) || iteration < 1) {
        return toolResult({ ok: false, message: "ultraplan_synth_draft requires a positive integer iteration" });
      }
      if (!isRecord(p.authored)) return toolResult({ ok: false, message: "ultraplan_synth_draft requires an authored object" });

      // Snapshot the planner's emission first (forensics) and then save the editable copy.
      const plannerSnapshot = saveDraftPlannerJson(platform.paths, cwdR.cwd, sidR.sessionId, iteration, p.authored);
      const snapshotResult = unwrap(plannerSnapshot, "ultraplan_synth_draft");
      if (!snapshotResult.ok) return toolResult(snapshotResult);

      const editable = saveDraftAuthoredJson(platform.paths, cwdR.cwd, sidR.sessionId, iteration, p.authored);
      const editableResult = unwrap(editable, "ultraplan_synth_draft");
      if (!editableResult.ok) return toolResult(editableResult);

      return toolResult({ ok: true, path: editableResult.value });
    },
  });

  // -------- ultraplan_review_finding ----------
  platform.registerTool({
    name: "ultraplan_review_finding",
    label: "UltraPlan Review Finding",
    description: "Append one finding from a review checker against a draft iteration.",
    parameters: {
      type: "object",
      properties: {
        sessionId: SESSION_ID_PROP,
        iteration: { type: "integer", minimum: 1 },
        id: { type: "string", description: "Stable id for this finding." },
        severity: { type: "string", enum: ["BLOCKER", "WARNING"] },
        source: { type: "string", enum: ["structure-checker", "scope-checker", "tdd-checker"] },
        target: FINDING_TARGET,
        message: { type: "string" },
        recommendation: { type: "string" },
      },
      required: ["sessionId", "iteration", "id", "severity", "source", "target", "message", "recommendation"],
    },
    async execute(_id: string, params: unknown, _signal: AbortSignal, _onUpdate: unknown, toolCtx: unknown) {
      const cwdR = readCwd(toolCtx, "ultraplan_review_finding");
      if (!cwdR.ok) return toolResult(cwdR);
      const sidR = readSessionId(params, "ultraplan_review_finding");
      if (!sidR.ok) return toolResult(sidR);

      const p = params as Record<string, unknown>;
      const iteration = typeof p.iteration === "number" ? p.iteration : 0;
      if (!Number.isInteger(iteration) || iteration < 1) {
        return toolResult({ ok: false, message: "ultraplan_review_finding requires a positive integer iteration" });
      }

      const finding: UltraPlanAuthoringFinding = {
        id: String(p.id),
        severity: p.severity as UltraPlanAuthoringFinding["severity"],
        source: p.source as UltraPlanAuthoringFinding["source"],
        target: p.target as UltraPlanAuthoringFinding["target"],
        message: String(p.message),
        recommendation: String(p.recommendation),
        recordedAt: new Date().toISOString(),
      };

      // Append to the iteration's findings.json: load if present, otherwise start fresh.
      const existing = loadFindingsArtifact(platform.paths, cwdR.cwd, sidR.sessionId, iteration);
      const findings = existing.ok
        ? [...existing.value.findings, finding]
        : [finding];
      const draftRef = `drafts/iteration-${iteration}/authored.json`;
      const artifact = {
        iteration,
        draftRef,
        recordedAt: new Date().toISOString(),
        findings,
      };
      const persisted = saveFindingsArtifact(platform.paths, cwdR.cwd, sidR.sessionId, iteration, artifact);
      const result = unwrap(persisted, "ultraplan_review_finding");
      if (!result.ok) return toolResult(result);
      return toolResult({ ok: true, path: result.value });
    },
  });

  // -------- ultraplan_revise_apply ----------
  platform.registerTool({
    name: "ultraplan_revise_apply",
    label: "UltraPlan Revise Apply",
    description: "Persist the revised authored.json + manifest.json for a new iteration after review feedback.",
    parameters: {
      type: "object",
      properties: {
        sessionId: SESSION_ID_PROP,
        iteration: { type: "integer", minimum: 2, description: "Revisions start at iteration 2." },
        authored: { type: "object" },
        manifest: { type: "object" },
      },
      required: ["sessionId", "iteration", "authored", "manifest"],
    },
    async execute(_id: string, params: unknown, _signal: AbortSignal, _onUpdate: unknown, toolCtx: unknown) {
      const cwdR = readCwd(toolCtx, "ultraplan_revise_apply");
      if (!cwdR.ok) return toolResult(cwdR);
      const sidR = readSessionId(params, "ultraplan_revise_apply");
      if (!sidR.ok) return toolResult(sidR);

      const p = params as Record<string, unknown>;
      const iteration = typeof p.iteration === "number" ? p.iteration : 0;
      if (!Number.isInteger(iteration) || iteration < 2) {
        return toolResult({ ok: false, message: "ultraplan_revise_apply requires iteration >= 2" });
      }
      if (!isRecord(p.authored)) return toolResult({ ok: false, message: "ultraplan_revise_apply requires an authored object" });

      // Same atomic write semantics as synth: planner snapshot then editable copy.
      const snapshot = saveDraftPlannerJson(platform.paths, cwdR.cwd, sidR.sessionId, iteration, p.authored);
      const snap = unwrap(snapshot, "ultraplan_revise_apply");
      if (!snap.ok) return toolResult(snap);
      const editable = saveDraftAuthoredJson(platform.paths, cwdR.cwd, sidR.sessionId, iteration, p.authored);
      const editableResult = unwrap(editable, "ultraplan_revise_apply");
      if (!editableResult.ok) return toolResult(editableResult);

      return toolResult({ ok: true, path: editableResult.value });
    },
  });
}

// ---------------------------------------------------------------------------
// Names exposed for hook-bridge correlation
// ---------------------------------------------------------------------------

export const ULTRAPLAN_AUTHORING_TOOL_NAMES = [
  "ultraplan_intake_record",
  "ultraplan_scout_record",
  "ultraplan_decision_record",
  "ultraplan_defer_idea",
  "ultraplan_research_record",
  "ultraplan_research_summary",
  "ultraplan_synth_draft",
  "ultraplan_review_finding",
  "ultraplan_revise_apply",
] as const;

export type UltraPlanAuthoringToolName = (typeof ULTRAPLAN_AUTHORING_TOOL_NAMES)[number];
