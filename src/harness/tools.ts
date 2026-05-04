/**
 * Harness pipeline tool registrations.
 *
 * Mirrors `src/ultraplan/authoring/authoring-tools.ts`:
 *  - one tool per stage artifact + queue mutation,
 *  - thin JSON-schema validation in the harness layer,
 *  - thin JSON-shape sanity check before the storage layer's atomic write,
 *  - structured `{ok, message?, path?, details?}` returns instead of thrown errors.
 *
 * Tools registered:
 *  - harness_discover_record
 *  - harness_research_record
 *  - harness_decision_record
 *  - harness_design_spec_persist
 *  - harness_validate_finding
 *  - harness_slop_queue_append
 *  - harness_slop_queue_resolve
 */

import type { Platform } from "../platform/types.js";
import type {
  HarnessSlopQueueEntry,
  HarnessValidateFinding,
  UltraPlanStorageResult,
} from "../types.js";
import {
  appendHarnessDecision,
  appendImplementLog,
  saveHarnessDesignSpec,
  saveHarnessDiscover,
  saveHarnessResearchTopic,
} from "./storage.js";
import {
  appendOpen as appendQueueEntry,
  computeQueueEntryId,
  resolve as resolveQueueEntry,
  markWontfix as markQueueWontfix,
} from "./anti_slop/queue.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ToolReturn {
  ok: boolean;
  message?: string;
  path?: string;
  id?: string;
  details?: unknown;
}

function toolResult(payload: ToolReturn): ToolReturn {
  return payload;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?$/;

function isSafeSessionId(value: string): boolean {
  if (!SESSION_ID_PATTERN.test(value)) return false;
  if (value.includes("..")) return false;
  return true;
}

function isSafeTopicSlug(value: string): boolean {
  // Stricter than session id: slugs cannot contain dots so they don't escape via
  // ".." or hidden files.
  return /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,126}[A-Za-z0-9_-])?$/.test(value);
}

function readSessionId(
  params: unknown,
  toolName: string,
): { ok: true; sessionId: string } | { ok: false; message: string } {
  if (!isRecord(params)) return { ok: false, message: `${toolName} requires an object payload` };
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

function unwrap<T>(result: UltraPlanStorageResult<T>, toolName: string): { ok: true; value: T } | { ok: false; message: string } {
  if (result.ok) return { ok: true, value: result.value };
  const detail = result.error.details && result.error.details.length > 0 ? `: ${result.error.details.join(", ")}` : "";
  return {
    ok: false,
    message: `${toolName} storage error (${result.error.kind}) at ${result.error.path}${detail}: ${result.error.message}`,
  };
}

// ---------------------------------------------------------------------------
// Schema fragments
// ---------------------------------------------------------------------------

const SESSION_ID_PROP = {
  type: "string",
  description: "Harness session id; assigned by the pipeline runner and passed through the agent prompt.",
} as const;

// ---------------------------------------------------------------------------
// Public registration entry point
// ---------------------------------------------------------------------------

/**
 * Register every harness pipeline tool. Idempotent at the harness boundary: when
 * `platform.registerTool` is missing (legacy harness), we silently no-op so existing
 * deploys keep booting.
 */
export function registerHarnessPipelineTools(platform: Platform): void {
  if (!platform.registerTool) return;

  // -------- harness_discover_record ----------
  platform.registerTool({
    name: "harness_discover_record",
    label: "Harness Discover Record",
    description: "Record the discover stage artifact for a harness session.",
    parameters: {
      type: "object",
      properties: {
        sessionId: SESSION_ID_PROP,
        artifact: {
          type: "object",
          description: "HarnessDiscoverArtifact JSON. Schema: docs/supipowers/harness.md.",
        },
      },
      required: ["sessionId", "artifact"],
    },
    async execute(_id: string, params: unknown, _signal: AbortSignal, _onUpdate: unknown, toolCtx: unknown) {
      const cwdR = readCwd(toolCtx, "harness_discover_record");
      if (!cwdR.ok) return toolResult(cwdR);
      const sidR = readSessionId(params, "harness_discover_record");
      if (!sidR.ok) return toolResult(sidR);
      const p = params as Record<string, unknown>;
      if (!isRecord(p.artifact)) {
        return toolResult({ ok: false, message: "harness_discover_record requires an artifact object" });
      }
      const persisted = saveHarnessDiscover(platform.paths, cwdR.cwd, sidR.sessionId, p.artifact as never);
      const result = unwrap(persisted, "harness_discover_record");
      if (!result.ok) return toolResult(result);
      return toolResult({ ok: true, path: result.value });
    },
  });

  // -------- harness_research_record ----------
  platform.registerTool({
    name: "harness_research_record",
    label: "Harness Research Record",
    description: "Record a research topic writeup for a harness session.",
    parameters: {
      type: "object",
      properties: {
        sessionId: SESSION_ID_PROP,
        topicSlug: {
          type: "string",
          description: "Slug for this topic (lowercase letters, digits, hyphen, underscore only).",
        },
        markdown: {
          type: "string",
          description: "Full markdown body. Must include `## Options` and `## Recommendation` headings and ≥2 source URLs.",
        },
      },
      required: ["sessionId", "topicSlug", "markdown"],
    },
    async execute(_id: string, params: unknown, _signal: AbortSignal, _onUpdate: unknown, toolCtx: unknown) {
      const cwdR = readCwd(toolCtx, "harness_research_record");
      if (!cwdR.ok) return toolResult(cwdR);
      const sidR = readSessionId(params, "harness_research_record");
      if (!sidR.ok) return toolResult(sidR);
      const p = params as Record<string, unknown>;
      const slug = typeof p.topicSlug === "string" ? p.topicSlug : "";
      if (!isSafeTopicSlug(slug)) {
        return toolResult({ ok: false, message: "harness_research_record rejected topicSlug: must be alphanumeric with hyphen/underscore only" });
      }
      const markdown = typeof p.markdown === "string" ? p.markdown : "";
      if (markdown.length === 0) {
        return toolResult({ ok: false, message: "harness_research_record requires a non-empty markdown body" });
      }
      const persisted = saveHarnessResearchTopic(platform.paths, cwdR.cwd, sidR.sessionId, slug, markdown);
      const result = unwrap(persisted, "harness_research_record");
      if (!result.ok) return toolResult(result);
      return toolResult({ ok: true, path: result.value });
    },
  });

  // -------- harness_decision_record ----------
  platform.registerTool({
    name: "harness_decision_record",
    label: "Harness Decision Record",
    description: "Append a single Design-stage decision to decisions.jsonl.",
    parameters: {
      type: "object",
      properties: {
        sessionId: SESSION_ID_PROP,
        area: { type: "string", description: "Short label for the decision area, e.g. 'anti-slop-backend'." },
        question: { type: "string", description: "The exact question that was answered." },
        decision: { type: "string", description: "The locked answer." },
        rationale: { type: "string", description: "Why this decision was chosen." },
        impact: { type: "array", items: { type: "string" }, description: "Modules / files this decision affects." },
      },
      required: ["sessionId", "area", "question", "decision"],
    },
    async execute(_id: string, params: unknown, _signal: AbortSignal, _onUpdate: unknown, toolCtx: unknown) {
      const cwdR = readCwd(toolCtx, "harness_decision_record");
      if (!cwdR.ok) return toolResult(cwdR);
      const sidR = readSessionId(params, "harness_decision_record");
      if (!sidR.ok) return toolResult(sidR);
      const p = params as Record<string, unknown>;
      const area = typeof p.area === "string" ? p.area : "";
      const question = typeof p.question === "string" ? p.question : "";
      const decision = typeof p.decision === "string" ? p.decision : "";
      if (!area || !question || !decision) {
        return toolResult({ ok: false, message: "harness_decision_record requires non-empty area, question, decision" });
      }
      const record: Record<string, unknown> = {
        recordedAt: new Date().toISOString(),
        area,
        question,
        decision,
        ...(typeof p.rationale === "string" ? { rationale: p.rationale } : {}),
        ...(Array.isArray(p.impact) ? { impact: p.impact } : {}),
      };
      const persisted = appendHarnessDecision(platform.paths, cwdR.cwd, sidR.sessionId, record);
      const r = unwrap(persisted, "harness_decision_record");
      if (!r.ok) return toolResult(r);
      return toolResult({ ok: true, path: r.value });
    },
  });

  // -------- harness_design_spec_persist ----------
  platform.registerTool({
    name: "harness_design_spec_persist",
    label: "Harness Design Spec Persist",
    description: "Persist the rendered design-spec.md for a harness session.",
    parameters: {
      type: "object",
      properties: {
        sessionId: SESSION_ID_PROP,
        markdown: { type: "string", description: "Full markdown body of the design spec." },
      },
      required: ["sessionId", "markdown"],
    },
    async execute(_id: string, params: unknown, _signal: AbortSignal, _onUpdate: unknown, toolCtx: unknown) {
      const cwdR = readCwd(toolCtx, "harness_design_spec_persist");
      if (!cwdR.ok) return toolResult(cwdR);
      const sidR = readSessionId(params, "harness_design_spec_persist");
      if (!sidR.ok) return toolResult(sidR);
      const p = params as Record<string, unknown>;
      const markdown = typeof p.markdown === "string" ? p.markdown : "";
      if (markdown.length === 0) {
        return toolResult({ ok: false, message: "harness_design_spec_persist requires a non-empty markdown body" });
      }
      const persisted = saveHarnessDesignSpec(platform.paths, cwdR.cwd, sidR.sessionId, markdown);
      const r = unwrap(persisted, "harness_design_spec_persist");
      if (!r.ok) return toolResult(r);
      return toolResult({ ok: true, path: r.value });
    },
  });

  // -------- harness_validate_finding ----------
  platform.registerTool({
    name: "harness_validate_finding",
    label: "Harness Validate Finding",
    description: "Append a single Validate-stage finding to the implement log (forensics).",
    parameters: {
      type: "object",
      properties: {
        sessionId: SESSION_ID_PROP,
        finding: {
          type: "object",
          properties: {
            severity: { type: "string", enum: ["error", "warning", "info"] },
            file: { type: "string" },
            line: { type: "integer", minimum: 1 },
            message: { type: "string" },
            remediation: { type: "string" },
            source: { type: "string" },
          },
          required: ["severity", "file", "message", "remediation", "source"],
        },
      },
      required: ["sessionId", "finding"],
    },
    async execute(_id: string, params: unknown, _signal: AbortSignal, _onUpdate: unknown, toolCtx: unknown) {
      const cwdR = readCwd(toolCtx, "harness_validate_finding");
      if (!cwdR.ok) return toolResult(cwdR);
      const sidR = readSessionId(params, "harness_validate_finding");
      if (!sidR.ok) return toolResult(sidR);
      const p = params as Record<string, unknown>;
      if (!isRecord(p.finding)) {
        return toolResult({ ok: false, message: "harness_validate_finding requires a finding object" });
      }
      const finding = p.finding as unknown as HarnessValidateFinding;
      const persisted = appendImplementLog(platform.paths, cwdR.cwd, sidR.sessionId, {
        kind: "validate-finding",
        recordedAt: new Date().toISOString(),
        finding,
      });
      const r = unwrap(persisted, "harness_validate_finding");
      if (!r.ok) return toolResult(r);
      return toolResult({ ok: true, path: r.value });
    },
  });

  // -------- harness_slop_queue_append ----------
  platform.registerTool({
    name: "harness_slop_queue_append",
    label: "Harness Slop Queue Append",
    description: "Append a slop violation to the project's persistent queue.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["duplicate", "dead-code", "layer-violation", "naming", "file-too-large", "complexity", "circular-dependency", "other"] },
        file: { type: "string" },
        startLine: { type: "integer", minimum: 1 },
        endLine: { type: "integer", minimum: 1 },
        severity: { type: "string", enum: ["blocker", "warning", "info"] },
        source: { type: "string", enum: ["fallow", "desloppify", "checks", "review", "supi-native"] },
        message: { type: "string" },
        remediation: { type: "string" },
        ruleHint: { type: "string", description: "Optional rule slug from the source backend; combined into the queue id hash." },
      },
      required: ["kind", "file", "severity", "source", "message"],
    },
    async execute(_id: string, params: unknown, _signal: AbortSignal, _onUpdate: unknown, toolCtx: unknown) {
      const cwdR = readCwd(toolCtx, "harness_slop_queue_append");
      if (!cwdR.ok) return toolResult(cwdR);
      if (!isRecord(params)) {
        return toolResult({ ok: false, message: "harness_slop_queue_append requires an object payload" });
      }
      const p = params as Record<string, unknown>;
      const range =
        typeof p.startLine === "number"
          ? { startLine: p.startLine, endLine: typeof p.endLine === "number" ? p.endLine : p.startLine }
          : null;
      const id = computeQueueEntryId({
        kind: p.kind as HarnessSlopQueueEntry["kind"],
        file: typeof p.file === "string" ? p.file : "",
        range,
        ruleHint: typeof p.ruleHint === "string" ? p.ruleHint : undefined,
      });
      const entry: HarnessSlopQueueEntry = {
        id,
        kind: p.kind as HarnessSlopQueueEntry["kind"],
        file: typeof p.file === "string" ? p.file : "",
        range,
        severity: p.severity as HarnessSlopQueueEntry["severity"],
        source: p.source as HarnessSlopQueueEntry["source"],
        state: "open",
        message: typeof p.message === "string" ? p.message : "",
        remediation: typeof p.remediation === "string" ? p.remediation : undefined,
        ts: new Date().toISOString(),
      };
      const persisted = appendQueueEntry(platform.paths, cwdR.cwd, entry);
      const r = unwrap(persisted, "harness_slop_queue_append");
      if (!r.ok) return toolResult(r);
      return toolResult({ ok: true, id, path: r.value });
    },
  });

  // -------- harness_slop_queue_resolve ----------
  platform.registerTool({
    name: "harness_slop_queue_resolve",
    label: "Harness Slop Queue Resolve",
    description: "Mark a queue entry as resolved or wontfix.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The queue entry id." },
        state: { type: "string", enum: ["resolved", "wontfix"] },
      },
      required: ["id", "state"],
    },
    async execute(_id: string, params: unknown, _signal: AbortSignal, _onUpdate: unknown, toolCtx: unknown) {
      const cwdR = readCwd(toolCtx, "harness_slop_queue_resolve");
      if (!cwdR.ok) return toolResult(cwdR);
      if (!isRecord(params)) {
        return toolResult({ ok: false, message: "harness_slop_queue_resolve requires an object payload" });
      }
      const p = params as Record<string, unknown>;
      const id = typeof p.id === "string" ? p.id : "";
      const state = typeof p.state === "string" ? p.state : "";
      if (!id || (state !== "resolved" && state !== "wontfix")) {
        return toolResult({ ok: false, message: "harness_slop_queue_resolve requires id and state ∈ {resolved, wontfix}" });
      }
      const result = state === "resolved"
        ? resolveQueueEntry(platform.paths, cwdR.cwd, id)
        : markQueueWontfix(platform.paths, cwdR.cwd, id);
      const r = unwrap(result, "harness_slop_queue_resolve");
      if (!r.ok) return toolResult(r);
      if (r.value === null) {
        return toolResult({ ok: false, message: `harness_slop_queue_resolve: id ${id} not found` });
      }
      return toolResult({ ok: true, id, details: { state } });
    },
  });
}

/** Names exposed for hook-bridge correlation. */
export const HARNESS_PIPELINE_TOOL_NAMES = [
  "harness_discover_record",
  "harness_research_record",
  "harness_decision_record",
  "harness_design_spec_persist",
  "harness_validate_finding",
  "harness_slop_queue_append",
  "harness_slop_queue_resolve",
] as const;

export type HarnessPipelineToolName = (typeof HARNESS_PIPELINE_TOOL_NAMES)[number];
