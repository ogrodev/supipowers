/**
 * Build a `SlopBackend` adapter from the user-selected backend choice.
 *
 * Lives here (in `anti_slop/`) so both `hooks/register.ts` and the per-stage CLI
 * subcommands in `command.ts` can call it without going through `register.ts`. Keeping
 * it in `register.ts` would create a circular import once the validate subcommand
 * needs the adapter.
 */

import type { HarnessAntiSlopBackend } from "../../types.js";
import type { SlopBackend } from "./backend.js";
import { DesloppifyAdapter } from "./desloppify-adapter.js";
import { FallowAdapter } from "./fallow-adapter.js";

export function buildBackendAdapter(
  backend: HarnessAntiSlopBackend,
): SlopBackend | null {
  switch (backend) {
    case "fallow":
      return new FallowAdapter();
    case "desloppify":
      return new DesloppifyAdapter();
    case "hybrid":
      // Hybrid prefers fallow for TS subtrees; the hook adapter is a single instance, so
      // we default to fallow and let GC fan out to desloppify for non-TS.
      return new FallowAdapter();
    case "supi-native":
      return null;
  }
}
