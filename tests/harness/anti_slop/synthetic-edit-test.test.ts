import { describe, expect, test } from "bun:test";

import { runSyntheticEditTest } from "../../../src/harness/anti_slop/synthetic-edit-test.js";
import type { HarnessLayerRule } from "../../../src/types.js";

const RULES: HarnessLayerRule[] = [
  {
    layer: "domain",
    globs: ["src/domain/**"],
    allowedImports: ["domain"],
    forbiddenImports: ["infra"],
  },
];

describe("runSyntheticEditTest", () => {
  test("records every enabled hook fire", () => {
    const result = runSyntheticEditTest({
      layerRules: RULES,
      hooks: {
        pre_edit_dupe_probe: { enabled: true },
        post_session_sweep: { enabled: true },
        layer_context_inject: { enabled: true, addendum_max_chars: 800 },
      },
    });
    expect(result.ran).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.hooksFired.sort()).toEqual([
      "layer_context_inject",
      "post_session_sweep",
      "pre_edit_dupe_probe",
    ]);
  });

  test("disabled hooks are skipped", () => {
    const result = runSyntheticEditTest({
      layerRules: RULES,
      hooks: {
        pre_edit_dupe_probe: { enabled: false },
        post_session_sweep: { enabled: false },
        layer_context_inject: { enabled: false, addendum_max_chars: 800 },
      },
    });
    expect(result.hooksFired).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.details.dupeHookDisabled).toBe(true);
    expect(result.details.sweepHookDisabled).toBe(true);
    expect(result.details.layerHookDisabled).toBe(true);
  });

  test("layer hook degrades gracefully with no matching rules", () => {
    const result = runSyntheticEditTest({
      layerRules: [],
      hooks: {
        pre_edit_dupe_probe: { enabled: false },
        post_session_sweep: { enabled: false },
        layer_context_inject: { enabled: true, addendum_max_chars: 800 },
      },
    });
    expect(result.failures).toEqual([]);
    expect(result.hooksFired).toEqual([]);
    expect(result.details.layerNoMatch).toBe(true);
  });
});
