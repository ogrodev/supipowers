import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { scanDesignTokens } from "../../src/ui-design/tokens-scanner.js";

const FIXTURES = path.resolve(import.meta.dir, "..", "fixtures", "ui-design");

describe("tokens scanner", () => {
  test("parses tailwind.config.js via static scan", async () => {
    const tokens = await scanDesignTokens(path.join(FIXTURES, "tailwind-project"));
    expect(tokens.status).toBe("ok");
    if (tokens.status === "ok") {
      expect(tokens.source).toBe("tailwind");
      expect(tokens.colors).toEqual({ primary: "#0070f3" });
      expect(tokens.fonts).toEqual({ sans: ["Inter"] });
      expect(typeof tokens.raw).toBe("string");
    }
  });

  test("parses :root CSS variables", async () => {
    const tokens = await scanDesignTokens(path.join(FIXTURES, "css-vars-project"));
    expect(tokens.status).toBe("ok");
    if (tokens.status === "ok") {
      expect(tokens.source).toBe("css-vars");
      expect(tokens.colors["color-primary"]).toBe("#0070f3");
      expect(tokens.fonts["font-sans"]).toEqual(["Inter"]);
    }
  });

  test("returns missing when nothing is found", async () => {
    const tokens = await scanDesignTokens(path.join(FIXTURES, "no-design-system"));
    expect(tokens.status).toBe("missing");
  });

  test("does not execute broken tailwind config and degrades to missing", async () => {
    const tokens = await scanDesignTokens(path.join(FIXTURES, "broken-tailwind-project"));
    expect(tokens.status).toBe("missing");
  });
});
