// src/config/schema.ts
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { SupipowersConfig, Profile } from "../types.js";

const ConfigSchema = Type.Object({
  version: Type.String(),
  defaultProfile: Type.String(),
  orchestration: Type.Object({
    maxParallelAgents: Type.Number({ minimum: 1, maximum: 10 }),
    maxFixRetries: Type.Number({ minimum: 0, maximum: 5 }),
    maxNestingDepth: Type.Number({ minimum: 0, maximum: 5 }),
    modelPreference: Type.String(),
  }),
  lsp: Type.Object({
    autoDetect: Type.Boolean(),
    setupGuide: Type.Boolean(),
  }),
  notifications: Type.Object({
    verbosity: Type.Union([
      Type.Literal("quiet"),
      Type.Literal("normal"),
      Type.Literal("verbose"),
    ]),
  }),
  qa: Type.Object({
    framework: Type.Union([Type.String(), Type.Null()]),
    command: Type.Union([Type.String(), Type.Null()]),
  }),
  release: Type.Object({
    pipeline: Type.Union([Type.String(), Type.Null()]),
  }),
});

export function validateConfig(data: unknown): { valid: boolean; errors: string[] } {
  const valid = Value.Check(ConfigSchema, data);
  if (valid) return { valid: true, errors: [] };
  const errors = [...Value.Errors(ConfigSchema, data)].map(
    (e) => `${e.path}: ${e.message}`
  );
  return { valid: false, errors };
}
