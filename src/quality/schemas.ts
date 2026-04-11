import { Type } from "@sinclair/typebox";
import type { TSchema } from "@sinclair/typebox";
import type { GateId } from "../types.js";

export const LspDiagnosticsGateConfigSchema = Type.Object(
  {
    enabled: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const CommandGateConfigSchema = Type.Union([
  Type.Object(
    {
      enabled: Type.Literal(false),
      command: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      enabled: Type.Literal(true),
      command: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
]);

export const QualityGatesSchema = Type.Object(
  {
    "lsp-diagnostics": Type.Optional(LspDiagnosticsGateConfigSchema),
    lint: Type.Optional(CommandGateConfigSchema),
    typecheck: Type.Optional(CommandGateConfigSchema),
    format: Type.Optional(CommandGateConfigSchema),
    "test-suite": Type.Optional(CommandGateConfigSchema),
    build: Type.Optional(CommandGateConfigSchema),
  },
  { additionalProperties: false },
);

export const GATE_CONFIG_SCHEMAS: Record<GateId, TSchema> = {
  "lsp-diagnostics": LspDiagnosticsGateConfigSchema,
  lint: CommandGateConfigSchema,
  typecheck: CommandGateConfigSchema,
  format: CommandGateConfigSchema,
  "test-suite": CommandGateConfigSchema,
  build: CommandGateConfigSchema,
};
