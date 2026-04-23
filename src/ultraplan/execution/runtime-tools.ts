import type { Platform } from "../../platform/types.js";
import {
  readActiveUltraPlanExecution,
  readActiveUltraPlanExecutionForCwd,
} from "../runtime/active-execution.js";

export interface UltraPlanRuntimeSignalProofInput {
  kind: "proof";
  summary: string;
  details?: Record<string, unknown>;
}

export interface UltraPlanRuntimeSignalBlockInput {
  kind: "block" | "await-user";
  code: string;
  summary: string;
  details?: Record<string, unknown>;
}

export type UltraPlanRuntimeSignalInput = UltraPlanRuntimeSignalProofInput | UltraPlanRuntimeSignalBlockInput;

export type UltraPlanRuntimeSignalPayload =
  | {
      kind: "proof";
      proof: {
        evidence: {
          summary: string;
          metadata?: Record<string, unknown>;
        };
      };
    }
  | {
      kind: "block" | "await-user";
      blocker: {
        code: string;
        message: string;
        details?: Record<string, unknown>;
      };
    };

export function registerUltraPlanRuntimeTools(platform: Platform): void {
  if (!platform.registerTool) {
    return;
  }

  platform.registerTool({
    name: "ultraplan_signal",
    label: "UltraPlan Signal",
    description: "Report proof, blocker, or await-user outcomes during an active UltraPlan execution attempt.",
    promptSnippet: "ultraplan_signal — emit proof/block/await-user for the active UltraPlan attempt",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["proof", "block", "await-user"], description: "Signal type" },
        code: { type: "string", description: "Blocker code for block/await-user signals" },
        summary: { type: "string", description: "Human-readable proof summary or blocker message" },
        details: { type: "object", additionalProperties: true, description: "Structured metadata attached to the signal" },
      },
      required: ["kind", "summary"],
    },
    async execute(_toolCallId: string, params: UltraPlanRuntimeSignalInput, _signal: AbortSignal, _onUpdate: unknown, toolCtx: any) {
      const execution = resolveActiveExecution(toolCtx);
      if (!execution) {
        return {
          content: [{ type: "text", text: "Error: ultraplan_signal requires an unambiguous active UltraPlan run." }],
          details: { error: "ultraplan_signal requires an unambiguous active UltraPlan run." },
        };
      }

      const payload = buildSignalPayload(params);
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        details: { payload, execution },
      };
    },
  });
}

function resolveActiveExecution(toolCtx: unknown) {
  const cwd = typeof (toolCtx as { cwd?: unknown } | null)?.cwd === "string"
    ? ((toolCtx as { cwd?: string }).cwd ?? null)
    : null;
  return cwd === null ? readActiveUltraPlanExecution() : readActiveUltraPlanExecutionForCwd(cwd);
}

function buildSignalPayload(params: UltraPlanRuntimeSignalInput): UltraPlanRuntimeSignalPayload {
  if (params.kind === "proof") {
    return {
      kind: "proof",
      proof: {
        evidence: {
          summary: params.summary,
          ...(params.details ? { metadata: params.details } : {}),
        },
      },
    };
  }

  return {
    kind: params.kind,
    blocker: {
      code: params.code,
      message: params.summary,
      ...(params.details ? { details: params.details } : {}),
    },
  };
}