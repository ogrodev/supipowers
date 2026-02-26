import { describe, expect, test } from "vitest";
import { chooseAdapter, detectCapabilities } from "../../src/adapters/capability-detector";

describe("capability detector", () => {
  test("detects subagent and colony capabilities", () => {
    const capabilities = detectCapabilities([
      { name: "read" },
      { name: "subagent" },
      { name: "ant_colony" },
      { name: "bg_colony_status" },
      { name: "write" },
    ]);

    expect(capabilities.subagent).toBe(true);
    expect(capabilities.antColony).toBe(true);
    expect(capabilities.antColonyStatus).toBe(true);
    expect(capabilities.native).toBe(true);
  });

  test("prefers ant colony for complex plans", () => {
    const capabilities = detectCapabilities([
      { name: "subagent" },
      { name: "ant_colony" },
      { name: "bg_colony_status" },
    ]);

    expect(chooseAdapter(capabilities, { stepCount: 5 })).toBe("ant_colony");
  });

  test("uses subagent for simple plans when available", () => {
    const capabilities = detectCapabilities([{ name: "subagent" }]);
    expect(chooseAdapter(capabilities, { stepCount: 1 })).toBe("subagent");
  });

  test("falls back to native when no external adapters", () => {
    const capabilities = detectCapabilities([{ name: "read" }, { name: "write" }]);
    expect(chooseAdapter(capabilities, { stepCount: 3 })).toBe("native");
  });
});
