import { Type } from "@sinclair/typebox";
import type { TSchema } from "@sinclair/typebox";
import type { GateId } from "../types.js";

export const LspDiagnosticsGateConfigSchema = Type.Object(
  {
    enabled: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const CommandGateRunTargetSchema = Type.Union([
  Type.Object(
    {
      scope: Type.Literal("all-targets"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      scope: Type.Literal("root"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      scope: Type.Literal("all-workspaces"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      scope: Type.Literal("workspace"),
      relativeDir: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
]);

export const CommandGateRunSchema = Type.Object(
  {
    command: Type.String({ minLength: 1 }),
    target: CommandGateRunTargetSchema,
  },
  { additionalProperties: false },
);

export const CommandGateConfigSchema = Type.Union([
  Type.Object(
    {
      enabled: Type.Literal(false),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      enabled: Type.Literal(true),
      runs: Type.Array(CommandGateRunSchema, { minItems: 1 }),
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
