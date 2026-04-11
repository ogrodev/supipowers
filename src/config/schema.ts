// src/config/schema.ts
import type { TSchema } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { SupipowersConfig } from "../types.js";
import { QualityGatesSchema } from "../quality/schemas.js";

export const ConfigSchema = Type.Object(
  {
    version: Type.String(),
    quality: Type.Object(
      {
        gates: QualityGatesSchema,
      },
      { additionalProperties: false },
    ),
    lsp: Type.Object(
      {
        setupGuide: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    notifications: Type.Object(
      {
        verbosity: Type.Union([
          Type.Literal("quiet"),
          Type.Literal("normal"),
          Type.Literal("verbose"),
        ]),
      },
      { additionalProperties: false },
    ),
    qa: Type.Object(
      {
        framework: Type.Union([Type.String(), Type.Null()]),
        e2e: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    release: Type.Object(
      {
        channels: Type.Array(
          Type.Union([Type.Literal("github"), Type.Literal("npm")]),
        ),
      },
      { additionalProperties: false },
    ),
    contextMode: Type.Object(
      {
        enabled: Type.Boolean(),
        compressionThreshold: Type.Number({ minimum: 1024 }),
        blockHttpCommands: Type.Boolean(),
        routingInstructions: Type.Boolean(),
        eventTracking: Type.Boolean(),
        compaction: Type.Boolean(),
        llmSummarization: Type.Boolean(),
        llmThreshold: Type.Number({ minimum: 4096 }),
        enforceRouting: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    mcp: Type.Object(
      {
        closeSessionsOnExit: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export interface ConfigParseError {
  source: "global" | "project";
  path: string;
  message: string;
}

export interface ConfigValidationError {
  path: string;
  message: string;
}

export interface InspectionLoadResult {
  mergedConfig: Record<string, unknown>;
  effectiveConfig: SupipowersConfig | null;
  parseErrors: ConfigParseError[];
  validationErrors: ConfigValidationError[];
}

function normalizeErrorPath(path: string): string {
  return path.replace(/^\//, "").replace(/\//g, ".") || "(root)";
}

function collectValidationErrors(schema: TSchema, data: unknown): ConfigValidationError[] {
  return [...Value.Errors(schema, data)].map((error) => ({
    path: normalizeErrorPath(error.path),
    message: error.message,
  }));
}

export function validateQualityGates(data: unknown): { valid: boolean; errors: string[] } {
  const errors = collectValidationErrors(QualityGatesSchema, data).map(
    (error) => `${error.path}: ${error.message}`,
  );

  return { valid: errors.length === 0, errors };
}

export function collectConfigValidationErrors(data: unknown): ConfigValidationError[] {
  return collectValidationErrors(ConfigSchema, data);
}

export function validateConfig(data: unknown): { valid: boolean; errors: string[] } {
  const errors = collectConfigValidationErrors(data).map(
    (error) => `${error.path}: ${error.message}`,
  );

  return { valid: errors.length === 0, errors };
}
