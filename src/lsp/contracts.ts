// src/lsp/contracts.ts
//
// TypeBox contract for the LSP diagnostics agent flow. Consumed by
// ai/structured-output.ts to schema-check model output and by
// ai/schema-text.ts to render the shape into the prompt.

import { z } from "zod/v4";

const DIAGNOSTIC_SEVERITIES = ["error", "warning", "info", "hint"] as const;

export const LspDiagnosticSchema = z.object({
  severity: z.enum(DIAGNOSTIC_SEVERITIES),
  message: z.string(),
  line: z.number(),
  column: z.number(),
}).strict();

export const LspDiagnosticsResultSchema = z.object({
  file: z.string(),
  diagnostics: z.array(LspDiagnosticSchema),
}).strict();

export const LspDiagnosticsResultsSchema = z.array(LspDiagnosticsResultSchema);

export type LspDiagnostic = z.infer<typeof LspDiagnosticSchema>;
export type LspDiagnosticsResult = z.infer<typeof LspDiagnosticsResultSchema>;
export type LspDiagnosticsResults = z.infer<typeof LspDiagnosticsResultsSchema>;
