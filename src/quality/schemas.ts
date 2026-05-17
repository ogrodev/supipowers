import { z } from "zod/v4";
import type { ZodType } from "zod/v4";
import type { GateId } from "../types.js";

export const LspDiagnosticsGateConfigSchema = z.object({
  enabled: z.boolean(),
}).strict();

export const CommandGateRunTargetSchema = z.union([
  z.object({
    scope: z.literal("all-targets"),
  }).strict(),
  z.object({
    scope: z.literal("root"),
  }).strict(),
  z.object({
    scope: z.literal("all-workspaces"),
  }).strict(),
  z.object({
    scope: z.literal("workspace"),
    relativeDir: z.string().min(1),
  }).strict(),
]);

export const CommandGateRunSchema = z.object({
  command: z.string().min(1),
  target: CommandGateRunTargetSchema,
}).strict();

export const CommandGateConfigSchema = z.union([
  z.object({
    enabled: z.literal(false),
  }).strict(),
  z.object({
    enabled: z.literal(true),
    runs: z.array(CommandGateRunSchema).min(1),
  }).strict(),
]);

export const QualityGatesSchema = z.object({
  "lsp-diagnostics": LspDiagnosticsGateConfigSchema.optional(),
  lint: CommandGateConfigSchema.optional(),
  typecheck: CommandGateConfigSchema.optional(),
  format: CommandGateConfigSchema.optional(),
  "test-suite": CommandGateConfigSchema.optional(),
  build: CommandGateConfigSchema.optional(),
}).strict();

export const GATE_CONFIG_SCHEMAS: Record<GateId, ZodType> = {
  "lsp-diagnostics": LspDiagnosticsGateConfigSchema,
  lint: CommandGateConfigSchema,
  typecheck: CommandGateConfigSchema,
  format: CommandGateConfigSchema,
  "test-suite": CommandGateConfigSchema,
  build: CommandGateConfigSchema,
};
