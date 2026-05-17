import { z } from "zod/v4";
import type { ZodType } from "zod/v4";
import type { SupipowersConfig } from "../types.js";
import { QualityGatesSchema } from "../quality/schemas.js";
import { UltraPlanConfigSchema } from "../ultraplan/contracts.js";
import { collectSchemaValidationErrors } from "../ai/schema-validation.js";

const TAG_FORMAT_PATTERN = "^(?:(?!\\$\\{version\\}).)*\\$\\{version\\}(?:(?!\\$\\{version\\}).)*$";


export const ConfigSchema = z.object(
  {
    version: z.string(),
    quality: z.object(
      {
        gates: QualityGatesSchema,
      },
    ).strict(),
    lsp: z.object(
      {
        setupGuide: z.boolean(),
      },
    ).strict(),
    qa: z.object(
      {
        framework: z.string().nullable(),
        e2e: z.boolean(),
      },
    ).strict(),
    release: z.object(
      {
        channels: z.array(z.string()),
        tagFormat: z.string().regex(new RegExp(TAG_FORMAT_PATTERN)),
        customChannels: z.record(
          z.string(),
          z.object({
            label: z.string(),
            publishCommand: z.string(),
            detectCommand: z.string().optional(),
          }),
        ).optional(),
      },
    ).strict(),
    ultraplan: UltraPlanConfigSchema,
    contextMode: z.object(
      {
        enabled: z.boolean(),
        compressionThreshold: z.number().min(1024),
        blockHttpCommands: z.boolean(),
        routingInstructions: z.boolean(),
        eventTracking: z.boolean(),
        compaction: z.boolean(),
        llmSummarization: z.boolean(),
        llmThreshold: z.number().min(4096),
        enforceRouting: z.boolean(),
        lazyTools: z.object(
          {
            enabled: z.boolean(),
            mode: z.enum(["conservative", "balanced", "aggressive"]),
            alwaysKeep: z.array(z.string()),
            commandAllowlist: z.record(z.string(), z.array(z.string())),
            keywordTools: z.record(z.string(), z.array(z.string())),
          },
        ).strict(),
        processors: z.object(
          {
            enabled: z.boolean(),
            disable: z.array(
              z.enum(["git", "test", "lint", "build", "k8s", "docker", "log", "json"]),
            ),
          },
        ).strict(),
        cacheHandles: z.object(
          {
            enabled: z.boolean(),
            spillThresholdBytes: z.number().min(1024),
            previewBytes: z.number().min(256),
          },
        ).strict(),
        repomap: z.object(
          {
            enabled: z.boolean(),
            tokenBudget: z.number().min(100),
            maxFiles: z.number().min(1),
          },
        ).strict(),
        memory: z.object(
          {
            enabled: z.boolean(),
            byteBudget: z.number().min(256),
            maxRows: z.number().min(1),
            retentionDays: z.number().min(1),
            focusChainCadence: z.number().int().min(1),
          },
        ).strict(),
      },
    ).strict(),
    mempalace: z.object(
      {
        enabled: z.boolean(),
        packageVersion: z.string().min(1),
        managedVenvPath: z.string().min(1),
        palacePath: z.string().min(1),
        defaultWingStrategy: z.enum(["repo-name", "project-slug", "explicit"]),
        explicitWing: z.string().nullable(),
        defaultAgentName: z.string().min(1),
        autoSetup: z.boolean(),
        hooks: z.object(
          {
            wakeUp: z.boolean(),
            searchGuidance: z.boolean(),
            autoSearchOnPrompt: z.boolean(),
            compactionCheckpoint: z.boolean(),
            shutdownDiary: z.boolean(),
          },
        ).strict(),
        budgets: z.object(
          {
            wakeUpTokens: z.number().int().min(1),
            searchResultChars: z.number().int().min(1),
            listResultChars: z.number().int().min(1),
            diaryChars: z.number().int().min(1),
            autoSearchTokens: z.number().int().min(1),
            wakeUpInjectionEvery: z.number().int().min(1),
            autoSearchSimilarityFloor: z.number().min(0).max(1),
            autoSearchBm25Floor: z.number().min(0),
          },
        ).strict(),
        timeouts: z.object(
          {
            setupMs: z.number().int().min(1),
            bridgeMs: z.number().int().min(1),
            hookMs: z.number().int().min(1),
          },
        ).strict(),
      },
    ).strict(),
  },
).strict();

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


function collectValidationErrors(schema: ZodType, data: unknown): ConfigValidationError[] {
  return collectSchemaValidationErrors(schema, data).map((error) => ({
    path: error.path,
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
