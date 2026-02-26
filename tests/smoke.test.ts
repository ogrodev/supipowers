import { describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../src/config";
import { formatStatus } from "../src/index";

describe("supipowers foundation", () => {
  test("has balanced default strictness", () => {
    expect(DEFAULT_CONFIG.strictness).toBe("balanced");
  });

  test("formats status line", () => {
    const line = formatStatus({
      phase: "idle",
      nextAction: "Run /sp-start",
    });

    expect(line).toContain("Supipowers phase: idle");
    expect(line).toContain("Run /sp-start");
  });
});
