import { describe, expect, test } from "bun:test";

import {
  buildHarnessRunner,
  HARNESS_STAGE_ORDER,
} from "../../src/harness/pipeline.js";

describe("harness pipeline", () => {
  test("stage order matches the contract", () => {
    expect(HARNESS_STAGE_ORDER).toEqual([
      "discover",
      "research",
      "design",
      "plan",
      "implement",
      "validate",
    ]);
  });

  test("buildHarnessRunner constructs each stage", () => {
    const discover = buildHarnessRunner("discover", {});
    expect(discover.stage).toBe("discover");
    const research = buildHarnessRunner("research", {});
    expect(research.stage).toBe("research");
    const plan = buildHarnessRunner("plan", {});
    expect(plan.stage).toBe("plan");
  });

  test("design without designInput throws", () => {
    expect(() => buildHarnessRunner("design", {})).toThrow();
  });

  test("implement without implementInput throws", () => {
    expect(() => buildHarnessRunner("implement", {})).toThrow();
  });

  test("validate without validateInput throws", () => {
    expect(() => buildHarnessRunner("validate", {})).toThrow();
  });
});
