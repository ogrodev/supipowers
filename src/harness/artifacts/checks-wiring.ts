/**
 * Wire `/supi:checks` to run the harness anti-slop scan as a custom gate.
 *
 * Builds a deep-mergeable patch for `.omp/supipowers/config.json`. The actual write
 * goes through `loadConfig`/the merge logic in `src/config/loader.ts`; this module only
 * supplies the patch object.
 *
 * Wiring is opt-in: callers pass `wireChecksGate: true` only when the user agreed to it
 * during Design.
 */

import type { HarnessAntiSlopBackend } from "../../types.js";

export interface ChecksWiringInput {
  backend: HarnessAntiSlopBackend;
  /** Strict score floor (mirrors `harness.anti_slop.score_floor.strict`). */
  strictFloor: number;
  /** When true, the gate fails CI on score-floor breach. */
  releaseBlocking: boolean;
}

export interface ChecksWiringPatch {
  harness: {
    anti_slop: {
      score_floor: {
        strict: number;
        release_blocking: boolean;
      };
    };
    backend: HarnessAntiSlopBackend;
  };
  /**
   * Annotation for a future config-schema extension that wires custom gates. Kept as a
   * string note so we do not synthesize structure the loader doesn't yet model.
   */
  notes: string[];
}

export function buildChecksWiringPatch(input: ChecksWiringInput): ChecksWiringPatch {
  return {
    harness: {
      anti_slop: {
        score_floor: {
          strict: input.strictFloor,
          release_blocking: input.releaseBlocking,
        },
      },
      backend: input.backend,
    },
    notes: [
      `Anti-slop scan runs via \`${input.backend === "fallow" ? "fallow audit" : input.backend === "desloppify" ? "desloppify scan" : "harness selected backend"}\` during /supi:checks.`,
      input.releaseBlocking
        ? `Release-blocking: /supi:checks fails when strict score < ${input.strictFloor}.`
        : `Score floor advisory: strict ${input.strictFloor}; not release-blocking.`,
    ],
  };
}
