// src/lsp/contracts.ts
//
// TypeBox contract for the LSP diagnostics agent flow. Consumed by
// ai/structured-output.ts to schema-check model output and by
// ai/schema-text.ts to render the shape into the prompt.

import { Type, type Static } from "@sinclair/typebox";

const DIAGNOSTIC_SEVERITIES = ["error", "warning", "info", "hint"] as const;

export const LspDiagnosticSchema = Type.Object(
  {
    severity: Type.Union(
      DIAGNOSTIC_SEVERITIES.map((value) => Type.Literal(value)),
    ),
    message: Type.String(),
    line: Type.Number(),
    column: Type.Number(),
  },
  { additionalProperties: false },
);

export const LspDiagnosticsResultSchema = Type.Object(
  {
    file: Type.String(),
    diagnostics: Type.Array(LspDiagnosticSchema),
  },
  { additionalProperties: false },
);

export const LspDiagnosticsResultsSchema = Type.Array(LspDiagnosticsResultSchema);

export type LspDiagnostic = Static<typeof LspDiagnosticSchema>;
export type LspDiagnosticsResult = Static<typeof LspDiagnosticsResultSchema>;
export type LspDiagnosticsResults = Static<typeof LspDiagnosticsResultsSchema>;
