import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { scanDesignContext } from "../../src/ui-design/scanner.js";

const FIXTURES = path.resolve(import.meta.dir, "..", "fixtures", "ui-design");

describe("scanner — composed design context", () => {
  test("full-stack project populates every field", async () => {
    const scan = await scanDesignContext(path.join(FIXTURES, "full-stack-project"));

    expect(scan.scannedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(scan.tokens.status).toBe("ok");
    if (scan.tokens.status === "ok") {
      expect(scan.tokens.source).toBe("tailwind");
    }

    expect(scan.components.status).toBe("ok");
    if (scan.components.status === "ok") {
      expect(scan.components.items).toHaveLength(1);
    }

    expect(scan.designMd.status).toBe("ok");
    if (scan.designMd.status === "ok") {
      expect(scan.designMd.path).toContain("design.md");
      expect(scan.designMd.bytes).toBeGreaterThan(0);
    }

    expect(scan.packageInfo.status).toBe("ok");
    if (scan.packageInfo.status === "ok") {
      expect(scan.packageInfo.framework).toBe("react");
      expect(scan.packageInfo.uiLibraries).toContain("tailwindcss");
      expect(scan.packageInfo.uiLibraries).toContain("@radix-ui");
    }
  });

  test("finds DESIGN.md (uppercase)", async () => {
    const scan = await scanDesignContext(path.join(FIXTURES, "design-md-project"));
    expect(scan.designMd.status).toBe("ok");
    if (scan.designMd.status === "ok") {
      expect(scan.designMd.path).toBe(path.join(FIXTURES, "design-md-project", "DESIGN.md"));
    }
  });

  test("finds docs/design.md", async () => {
    const scan = await scanDesignContext(path.join(FIXTURES, "docs-design-project"));
    expect(scan.designMd.status).toBe("ok");
    if (scan.designMd.status === "ok") {
      expect(scan.designMd.path).toMatch(/docs[\\/]design\.md$/);
    }
  });

  test("no-design-system fixture degrades every field to missing", async () => {
    const scan = await scanDesignContext(path.join(FIXTURES, "no-design-system"));
    expect(scan.scannedAt).toBeTruthy();
    expect(scan.tokens.status).toBe("missing");
    expect(scan.components.status).toBe("missing");
    expect(scan.designMd.status).toBe("missing");
    // packageInfo resolves — has a package.json with name/version but no deps
    expect(["ok", "missing"]).toContain(scan.packageInfo.status);
  });

  test("totality — non-existent repoRoot never throws", async () => {
    const scan = await scanDesignContext("/nonexistent/path/xyz");
    expect(scan).toBeDefined();
    expect(scan.scannedAt).toBeTruthy();
    // every field reports missing or error, never throws
    expect(["ok", "missing", "error"]).toContain(scan.tokens.status);
    expect(["ok", "missing", "error"]).toContain(scan.components.status);
  });
});
