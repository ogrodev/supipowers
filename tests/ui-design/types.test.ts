import { describe, expect, test } from "bun:test";
import type {
  UiDesignScope,
  UiDesignBackendId,
  ScanFieldStatus,
  DesignTokens,
  ExistingComponent,
  ContextScan,
  UiDesignSession,
  Manifest,
  ManifestStatus,
} from "../../src/ui-design/types.js";

describe("ui-design types", () => {
  test("scope literal", () => {
    const scope: UiDesignScope = "page";
    expect(["page", "flow", "component"]).toContain(scope);
  });

  test("backend id literal", () => {
    const id: UiDesignBackendId = "local-html";
    expect(id).toBe("local-html");
  });

  test("scan field status literals", () => {
    const ok: ScanFieldStatus = "ok";
    const missing: ScanFieldStatus = "missing";
    const error: ScanFieldStatus = "error";
    expect([ok, missing, error]).toEqual(["ok", "missing", "error"]);
  });

  test("design tokens shape", () => {
    const tokens = {
      status: "ok",
      source: "tailwind",
      colors: { primary: "#0070f3" },
      fonts: { sans: ["Inter"] },
      raw: "module.exports = {}",
    } satisfies DesignTokens;
    expect(tokens.status).toBe("ok");
  });

  test("existing component shape", () => {
    const component = {
      name: "Button",
      path: "components/Button.tsx",
      framework: "react",
      exports: ["Button"],
    } satisfies ExistingComponent;
    expect(component.framework).toBe("react");
  });

  test("context scan shape", () => {
    const scan = {
      scannedAt: "2026-04-18T00:00:00.000Z",
      tokens: { status: "missing" },
      components: { status: "ok", items: [] },
      designMd: { status: "missing" },
      packageInfo: { status: "missing" },
    } satisfies ContextScan;
    expect(scan.tokens.status).toBe("missing");
  });

  test("ui design session shape", () => {
    const session = {
      id: "uidesign-20260418-120000-abcd",
      dir: "/repo/.omp/supipowers/ui-design/uidesign-20260418-120000-abcd",
      scope: "page",
      topic: "landing page",
      backend: "local-html",
      companionUrl: "http://localhost:4321",
    } satisfies UiDesignSession;
    expect(session.backend).toBe("local-html");
  });

  test("manifest status literals", () => {
    const statuses: ManifestStatus[] = [
      "in-progress",
      "critiquing",
      "awaiting-review",
      "complete",
      "discarded",
    ];
    expect(statuses).toHaveLength(5);
  });

  test("manifest canonical shape", () => {
    const manifest = {
      id: "uidesign-20260418-120000-abcd",
      scope: "page",
      topic: "landing page",
      backend: "local-html",
      status: "in-progress",
      acknowledged: false,
      createdAt: "2026-04-18T00:00:00.000Z",
      components: ["hero", "footer"],
      sections: ["top", "bottom"],
      page: "page.html",
    } satisfies Manifest;
    expect(manifest.status).toBe("in-progress");
    expect(manifest.acknowledged).toBe(false);
  });

  test("manifest with critique + approvedAt", () => {
    const manifest = {
      id: "uidesign-20260418-120000-abcd",
      scope: "component",
      backend: "local-html",
      status: "complete",
      acknowledged: true,
      createdAt: "2026-04-18T00:00:00.000Z",
      approvedAt: "2026-04-18T01:00:00.000Z",
      components: [],
      sections: [],
      page: "page.html",
      critique: { fixableCount: 2, advisoryCount: 4, fixIterations: 1 },
    } satisfies Manifest;
    expect(manifest.critique?.fixIterations).toBe(1);
  });
});
