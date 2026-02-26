import { describe, expect, test } from "vitest";
import { canTransition } from "../../src/engine/transitions";

describe("transitions", () => {
  test("rejects same-state transition", () => {
    const result = canTransition("idle", "idle");
    expect(result.ok).toBe(false);
  });

  test("accepts canonical next transition", () => {
    const result = canTransition("planning", "plan_ready");
    expect(result.ok).toBe(true);
  });

  test("rejects out-of-order transition", () => {
    const result = canTransition("planning", "ready_to_finish");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Invalid transition");
  });
});
