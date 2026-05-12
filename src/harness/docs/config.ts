/**
 * Resolve the effective `HarnessDocsConfig`.
 *
 * For Slice 1/2 we return the defaults declared in `DEFAULT_HARNESS_CONFIG.docs`. Slice
 * 4 wires this through to the project-scoped config file so users can override
 * individual tunables.
 *
 * The tier toggle itself lives on the per-session manifest (`HarnessSession.docsTier`) and
 * is resolved by the stage runner — not here.
 */

import type { PlatformPaths } from "../../platform/types.js";
import type { HarnessDocsConfig } from "../../types.js";
import { DEFAULT_HARNESS_DOCS_CONFIG } from "../hooks/register.js";

/**
 * Resolve the effective docs config for a given project. Tunables fall back to defaults
 * when absent. The tier field is included for completeness but consumers should rely on
 * `HarnessSession.docsTier` for the operational decision — the session is the
 * authoritative source.
 */
export function resolveDocsConfig(
  _paths: PlatformPaths,
  _cwd: string,
): HarnessDocsConfig {
  // Future: layer a project-scoped JSON file (.omp/supipowers/config.json#harness.docs)
  // over these defaults. For now we return the bare defaults; Slice 4 extends this.
  return { ...DEFAULT_HARNESS_DOCS_CONFIG };
}
