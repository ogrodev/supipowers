// src/quality/registry.ts
import type { TSchema } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import type { GateDefinition, GateId } from "../types.js";

export type GateRegistry = Partial<Record<GateId, GateDefinition<any>>>;

export const CANONICAL_GATE_ORDER: GateId[] = [
  "lsp-diagnostics",
  "test-suite",
  "ai-review",
];

export const GATE_CONFIG_SCHEMAS: Record<GateId, TSchema> = {
  "lsp-diagnostics": Type.Object(
    {
      enabled: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  "test-suite": Type.Union([
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
  ]),
  "ai-review": Type.Object(
    {
      enabled: Type.Boolean(),
      depth: Type.Union([Type.Literal("quick"), Type.Literal("deep")]),
    },
    { additionalProperties: false },
  ),
};
