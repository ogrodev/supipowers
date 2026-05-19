import { describe, expect, test } from "bun:test";

import { getCiPlan, resolveCiProfile } from "../../src/ci.js";

describe("CI plan", () => {
  test("default profile runs typecheck and the full test suite", () => {
    expect(getCiPlan("default")).toEqual([
      { label: "Typecheck", args: ["bun", "run", "typecheck"] },
      { label: "Test", args: ["bun", "run", "test"] },
    ]);
  });

  test("windows-fast profile keeps typecheck but swaps in the Windows portability suite", () => {
    expect(getCiPlan("windows-fast")).toEqual([
      { label: "Typecheck", args: ["bun", "run", "typecheck"] },
      { label: "Windows portability tests", args: ["bun", "run", "test:windows"] },
    ]);
  });

  test("empty profile resolves to default and unknown profiles fail closed", () => {
    expect(resolveCiProfile(undefined)).toBe("default");
    expect(resolveCiProfile("")).toBe("default");
    expect(() => resolveCiProfile("fast"))
      .toThrow("Unsupported SUPIPOWERS_CI_PROFILE: fast");
  });
});
