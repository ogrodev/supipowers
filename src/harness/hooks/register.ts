/**
 * Hook registrar — wires every harness hook (pre-edit dupe probe, post-session sweep,
 * layer-context-inject) onto the platform.
 *
 * **Project-scoped**: hooks are gated by `<repo>/.omp/supipowers/harness/marker.json`.
 * The registrar runs at extension boot but each individual hook checks the marker on
 * every event so a repo without the harness installed sees no behavior change.
 *
 * Hook activation also depends on the per-hook `enabled` flag in
 * `.omp/supipowers/config.json`; we read that lazily inside each hook so config edits
 * take effect on the next event without restarting OMP.
 */

import type { Platform } from "../../platform/types.js";
import type { HarnessConfig, HarnessHookConfig } from "../../types.js";
import { FallowAdapter } from "../anti_slop/fallow-adapter.js";
import { DesloppifyAdapter } from "../anti_slop/desloppify-adapter.js";
import type { SlopBackend } from "../anti_slop/backend.js";
import {
  registerLayerContextInjectHook,
} from "./layer-context-inject.js";
import {
  registerPostSessionSweepHook,
} from "./post-session-sweep.js";
import {
  registerPreEditDupeProbeHook,
} from "./pre-edit-dupe-probe.js";

export const DEFAULT_HARNESS_HOOK_CONFIG: HarnessHookConfig = {
  pre_edit_dupe_probe: { enabled: true, threshold: 0.85, min_token_count: 30 },
  post_session_sweep: { enabled: true, block_on_new_dead_code: false },
  layer_context_inject: { enabled: true, addendum_max_chars: 800 },
  score_floor: { strict: 75, lenient: 90, release_blocking: false },
};

export const DEFAULT_HARNESS_CONFIG: HarnessConfig = {
  anti_slop: DEFAULT_HARNESS_HOOK_CONFIG,
  implement_in_session_threshold: 10,
};

export interface HarnessHookRegistration {
  /** Tear down every registered hook. Used by tests for clean isolation. */
  dispose(): void;
  /** True if any hook actually subscribed (i.e. config + backend allow it). */
  active: boolean;
}

export interface RegisterHooksOptions {
  /** Backend to use for the duplicate / dead-code adapters. Defaults to fallow. */
  backend?: "fallow" | "desloppify" | "supi-native" | "hybrid";
  /** Hook config snapshot. Defaults to DEFAULT_HARNESS_HOOK_CONFIG. */
  hooks?: HarnessHookConfig;
  /**
   * Extracts the candidate file the agent is about to edit. Implementations consult
   * session state. Defaults to a no-op resolver (the layer-inject hook becomes a no-op
   * unless a real resolver is wired).
   */
  resolveCandidateFile?: (event: unknown, ctx: unknown) => string | null;
}

function buildBackendAdapter(backend: NonNullable<RegisterHooksOptions["backend"]>): SlopBackend | null {
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

/**
 * Register every harness hook. Idempotent at the dispose boundary: calling
 * `dispose()` twice is safe.
 */
export function registerHarnessHooks(
  platform: Platform,
  options: RegisterHooksOptions = {},
): HarnessHookRegistration {
  const backend = options.backend ?? "fallow";
  const hooks = options.hooks ?? DEFAULT_HARNESS_HOOK_CONFIG;
  const adapter = buildBackendAdapter(backend);

  const teardowns: Array<() => void> = [];
  let active = false;

  if (hooks.pre_edit_dupe_probe.enabled && adapter) {
    teardowns.push(
      registerPreEditDupeProbeHook(platform, {
        adapter,
        config: hooks.pre_edit_dupe_probe,
      }),
    );
    active = true;
  }
  if (hooks.post_session_sweep.enabled && adapter) {
    teardowns.push(
      registerPostSessionSweepHook(platform, {
        adapter,
        config: hooks.post_session_sweep,
      }),
    );
    active = true;
  }
  if (hooks.layer_context_inject.enabled) {
    teardowns.push(
      registerLayerContextInjectHook(platform, {
        config: hooks.layer_context_inject,
        resolveCandidateFile: options.resolveCandidateFile ?? (() => null),
      }),
    );
    active = true;
  }

  return {
    active,
    dispose() {
      while (teardowns.length > 0) {
        const t = teardowns.pop();
        try {
          t?.();
        } catch {
          // best-effort
        }
      }
    },
  };
}
