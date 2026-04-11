// src/quality/registry.ts
import type { GateDefinition, GateId } from "../types.js";
import { GATE_CONFIG_SCHEMAS } from "./schemas.js";

export type GateRegistry = Partial<Record<GateId, GateDefinition<any>>>;

export const GATE_DISPLAY_NAMES: Record<GateId, string> = {
  "lsp-diagnostics": "LSP diagnostics",
  lint: "Lint",
  typecheck: "Typecheck",
  format: "Format check",
  "test-suite": "Test suite",
  build: "Build",
};

export const CANONICAL_GATE_ORDER: GateId[] = [
  "lsp-diagnostics",
  "lint",
  "typecheck",
  "format",
  "test-suite",
  "build",
];

export { GATE_CONFIG_SCHEMAS };
