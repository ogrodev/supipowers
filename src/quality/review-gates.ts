import type { ProjectFacts, QualityGatesConfig } from "../types.js";
import { CANONICAL_GATE_ORDER, GATE_DISPLAY_NAMES, type GateRegistry } from "./registry.js";
import { lspDiagnosticsGate } from "./gates/lsp-diagnostics.js";
import { lintGate } from "./gates/lint.js";
import { typecheckGate } from "./gates/typecheck.js";
import { formatGate } from "./gates/format.js";
import { testSuiteGate } from "./gates/test-suite.js";
import { buildGate } from "./gates/build.js";

export const REVIEW_GATE_REGISTRY: GateRegistry = {
  "lsp-diagnostics": lspDiagnosticsGate,
  lint: lintGate,
  typecheck: typecheckGate,
  format: formatGate,
  "test-suite": testSuiteGate,
  build: buildGate,
};

export function detectReviewGates(projectFacts: ProjectFacts): QualityGatesConfig {
  const gates: QualityGatesConfig = {};

  for (const gateId of CANONICAL_GATE_ORDER) {
    const definition = REVIEW_GATE_REGISTRY[gateId];
    const detection = definition?.detect(projectFacts);
    if (!detection?.suggestedConfig) {
      continue;
    }

    gates[gateId] = detection.suggestedConfig as never;
  }

  return gates;
}

export function collectReviewGateNotes(projectFacts: ProjectFacts): string[] {
  const notes: string[] = [];

  for (const gateId of CANONICAL_GATE_ORDER) {
    const definition = REVIEW_GATE_REGISTRY[gateId];
    const detection = definition?.detect(projectFacts);
    if (!detection?.reason || !detection.reason.includes("target")) {
      continue;
    }

    notes.push(`${GATE_DISPLAY_NAMES[gateId]}: ${detection.reason}`);
  }

  return notes;
}
