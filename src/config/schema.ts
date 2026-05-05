import type { TSchema } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { SupipowersConfig } from "../types.js";
import { QualityGatesSchema } from "../quality/schemas.js";
import { UltraPlanConfigSchema } from "../ultraplan/contracts.js";

const TAG_FORMAT_PATTERN = "^(?:(?!\\$\\{version\\}).)*\\$\\{version\\}(?:(?!\\$\\{version\\}).)*$";


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
    qa: Type.Object(
      {
        framework: Type.Union([Type.String(), Type.Null()]),
        e2e: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    release: Type.Object(
      {
        channels: Type.Array(Type.String()),
        tagFormat: Type.String({ pattern: TAG_FORMAT_PATTERN }),
        customChannels: Type.Optional(
          Type.Record(
            Type.String(),
            Type.Object({
              label: Type.String(),
              publishCommand: Type.String(),
              detectCommand: Type.Optional(Type.String()),
            }),
          ),
        ),
      },
      { additionalProperties: false },
    ),
    ultraplan: UltraPlanConfigSchema,
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
        lazyTools: Type.Object(
          {
            enabled: Type.Boolean(),
            mode: Type.Union([
              Type.Literal("conservative"),
              Type.Literal("balanced"),
              Type.Literal("aggressive"),
            ]),
            alwaysKeep: Type.Array(Type.String()),
            commandAllowlist: Type.Record(Type.String(), Type.Array(Type.String())),
            keywordTools: Type.Record(Type.String(), Type.Array(Type.String())),
          },
          { additionalProperties: false },
        ),
        processors: Type.Object(
          {
            enabled: Type.Boolean(),
            disable: Type.Array(
              Type.Union([
                Type.Literal("git"),
                Type.Literal("test"),
                Type.Literal("lint"),
                Type.Literal("build"),
                Type.Literal("k8s"),
                Type.Literal("docker"),
                Type.Literal("log"),
                Type.Literal("json"),
              ]),
            ),
          },
          { additionalProperties: false },
        ),
        cacheHandles: Type.Object(
          {
            enabled: Type.Boolean(),
            spillThresholdBytes: Type.Number({ minimum: 1024 }),
            previewBytes: Type.Number({ minimum: 256 }),
          },
          { additionalProperties: false },
        ),
        repomap: Type.Object(
          {
            enabled: Type.Boolean(),
            tokenBudget: Type.Number({ minimum: 100 }),
            maxFiles: Type.Number({ minimum: 1 }),
          },
          { additionalProperties: false },
        ),
        memory: Type.Object(
          {
            enabled: Type.Boolean(),
            byteBudget: Type.Number({ minimum: 256 }),
            maxRows: Type.Number({ minimum: 1 }),
            retentionDays: Type.Number({ minimum: 1 }),
            focusChainCadence: Type.Integer({ minimum: 1 }),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    mcp: Type.Object(
      {
        closeSessionsOnExit: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    mempalace: Type.Object(
      {
        enabled: Type.Boolean(),
        packageVersion: Type.String({ minLength: 1 }),
        managedVenvPath: Type.String({ minLength: 1 }),
        palacePath: Type.String({ minLength: 1 }),
        defaultWingStrategy: Type.Union([
          Type.Literal("repo-name"),
          Type.Literal("project-slug"),
          Type.Literal("explicit"),
        ]),
        explicitWing: Type.Union([Type.String(), Type.Null()]),
        defaultAgentName: Type.String({ minLength: 1 }),
        autoSetup: Type.Boolean(),
        hooks: Type.Object(
          {
            wakeUp: Type.Boolean(),
            searchGuidance: Type.Boolean(),
            compactionCheckpoint: Type.Boolean(),
            shutdownDiary: Type.Boolean(),
          },
          { additionalProperties: false },
        ),
        budgets: Type.Object(
          {
            wakeUpTokens: Type.Integer({ minimum: 1 }),
            searchResultChars: Type.Integer({ minimum: 1 }),
            listResultChars: Type.Integer({ minimum: 1 }),
            diaryChars: Type.Integer({ minimum: 1 }),
          },
          { additionalProperties: false },
        ),
        timeouts: Type.Object(
          {
            setupMs: Type.Integer({ minimum: 1 }),
            bridgeMs: Type.Integer({ minimum: 1 }),
            hookMs: Type.Integer({ minimum: 1 }),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ), 
  },
  { additionalProperties: false },
);

export interface ConfigParseError {
  source: "global" | "root";
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
