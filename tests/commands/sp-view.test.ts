import { describe, expect, test } from "vitest";
import { parseViewArgs } from "../../src/commands/sp-view";

describe("sp-view args", () => {
  test("parses supported actions", () => {
    expect(parseViewArgs("")).toBe("toggle");
    expect(parseViewArgs("toggle")).toBe("toggle");
    expect(parseViewArgs("compact")).toBe("compact");
    expect(parseViewArgs("full")).toBe("full");
    expect(parseViewArgs("status")).toBe("status");
  });

  test("rejects invalid action", () => {
    expect(parseViewArgs("banana")).toBeUndefined();
  });
});
