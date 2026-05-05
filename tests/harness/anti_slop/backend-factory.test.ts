import { describe, expect, test } from "bun:test";

import { buildBackendAdapter } from "../../../src/harness/anti_slop/backend-factory.js";
import { FallowAdapter } from "../../../src/harness/anti_slop/fallow-adapter.js";
import { DesloppifyAdapter } from "../../../src/harness/anti_slop/desloppify-adapter.js";

describe("buildBackendAdapter", () => {
  test("fallow → FallowAdapter", () => {
    expect(buildBackendAdapter("fallow")).toBeInstanceOf(FallowAdapter);
  });

  test("hybrid → FallowAdapter (TS-first)", () => {
    expect(buildBackendAdapter("hybrid")).toBeInstanceOf(FallowAdapter);
  });

  test("desloppify → DesloppifyAdapter", () => {
    expect(buildBackendAdapter("desloppify")).toBeInstanceOf(DesloppifyAdapter);
  });

  test("supi-native → null", () => {
    expect(buildBackendAdapter("supi-native")).toBeNull();
  });
});
