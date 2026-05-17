// src/lsp/capabilities.ts
//
// Probe the active LSP server's capabilities once per gate run.
// Used to short-circuit diagnostic collection (and any future capability-
// gated workflow) when the server has no `textDocument/diagnostic` support,
// instead of failing the gate on a vacuous error.
//
// The probe asks an agent to invoke the lsp tool with action "capabilities"
// (introduced in OMP 14.5.13) and emit a tiny JSON record summarizing which
// methods at least one active server advertises. Failure to probe is
// treated as fail-closed: NO_LSP_SUPPORT (gate skips rather than pretending
// it ran).

import { z } from "zod/v4";
import {
  parseStructuredOutput,
  runWithOutputValidation,
  type ReliabilityReporter,
} from "../ai/structured-output.js";
import { renderSchemaText } from "../ai/schema-text.js";
import type { GateExecutionContext } from "../types.js";

export const LspCapabilitiesSchema = z.object({
  diagnostics: z.boolean(),
  references: z.boolean(),
  definition: z.boolean(),
  hover: z.boolean(),
  rename: z.boolean(),
}).strict();

export type LspCapabilities = z.infer<typeof LspCapabilitiesSchema>;

const SCHEMA_TEXT = renderSchemaText(LspCapabilitiesSchema);

const PROBE_PROMPT = [
  "You are probing LSP server capabilities for a quality gate.",
  'Run the lsp tool with action: "capabilities" and file: "*".',
  "Examine the returned capabilities and emit JSON only matching this schema:",
  SCHEMA_TEXT,
  "",
  "Rules:",
  "- `diagnostics`: true when at least one server advertises `textDocument/diagnostic` or `textDocument/publishDiagnostics` support.",
  "- `references`: true when at least one server advertises `textDocument/references`.",
  "- `definition`, `hover`, `rename`: same pattern for their LSP method names.",
  "- Use `false` when the capability is missing, not when you are unsure.",
  "- Do not wrap the JSON in markdown fences.",
].join("\n");

/** Pessimistic default: every capability is missing. Used as fail-closed
 *  fallback when the probe itself fails or returns blocked. */
export const NO_LSP_SUPPORT: LspCapabilities = {
  diagnostics: false,
  references: false,
  definition: false,
  hover: false,
  rename: false,
};

/** Optimistic default: every capability advertised. Used by tests and as a
 *  reference shape for the probe contract. */
export const FULL_LSP_SUPPORT: LspCapabilities = {
  diagnostics: true,
  references: true,
  definition: true,
  hover: true,
  rename: true,
};

export interface ProbeLspCapabilitiesOptions {
  cwd: string;
  createAgentSession: GateExecutionContext["createAgentSession"];
  reviewModel?: GateExecutionContext["reviewModel"];
  reliability?: ReliabilityReporter;
}

/**
 * Probe LSP capabilities. Returns NO_LSP_SUPPORT when the probe blocks or
 * throws — callers must treat unknown as unsupported and skip cleanly
 * rather than running a workflow that depends on the missing capability.
 */
export async function probeLspCapabilities(
  options: ProbeLspCapabilitiesOptions,
): Promise<LspCapabilities> {
  try {
    const result = await runWithOutputValidation<LspCapabilities>(
      options.createAgentSession,
      {
        cwd: options.cwd,
        prompt: PROBE_PROMPT,
        schema: SCHEMA_TEXT,
        parse: (raw) => parseStructuredOutput<LspCapabilities>(raw, LspCapabilitiesSchema),
        model: options.reviewModel?.model,
        thinkingLevel: options.reviewModel?.thinkingLevel ?? null,
        timeoutMs: 60_000,
        reliability: options.reliability,
      },
    );
    if (result.status === "blocked") {
      return NO_LSP_SUPPORT;
    }
    return result.output;
  } catch {
    return NO_LSP_SUPPORT;
  }
}
