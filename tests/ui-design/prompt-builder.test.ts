import { describe, expect, test } from "bun:test";
import {
  buildUiDesignKickoffPrompt,
  renderContextScanSummary,
} from "../../src/ui-design/prompt-builder.js";
import type { ContextScan } from "../../src/ui-design/types.js";

const BASE_OPTS = {
  sessionDir: "/repo/.omp/supipowers/ui-design/uidesign-xxx",
  companionUrl: "http://localhost:4321",
  contextScanSummary: "Framework: react · Tokens: tailwind · Components: 1",
};

describe("ui-design kickoff prompt", () => {
  test("includes session dir, companion URL, topic, and scan summary", () => {
    const prompt = buildUiDesignKickoffPrompt({ ...BASE_OPTS, topic: "landing page" });
    expect(prompt).toContain("/repo/.omp/supipowers/ui-design/uidesign-xxx");
    expect(prompt).toContain("http://localhost:4321");
    expect(prompt).toContain("landing page");
    expect(prompt).toContain("Framework: react");
  });

  test("without a topic instructs director to ask the user", () => {
    const prompt = buildUiDesignKickoffPrompt(BASE_OPTS);
    expect(prompt).toContain("planning_ask");
    expect(prompt.length).toBeLessThan(1500);
  });

  test("kickoff string stays short", () => {
    const prompt = buildUiDesignKickoffPrompt({ ...BASE_OPTS, topic: "onboarding flow" });
    expect(prompt.length).toBeLessThanOrEqual(1500);
  });
});

describe("renderContextScanSummary", () => {
  const scan: ContextScan = {
    scannedAt: "2026-04-18T00:00:00.000Z",
    tokens: { status: "ok", source: "tailwind", colors: { primary: "#0070f3" }, fonts: { sans: ["Inter"] }, raw: "" },
    components: {
      status: "ok",
      items: [
        { name: "Button", path: "components/Button.tsx", framework: "react", exports: ["Button"] },
        { name: "Card", path: "components/Card.tsx", framework: "react", exports: ["Card"] },
      ],
    },
    designMd: { status: "ok", path: "/repo/design.md", bytes: 200 },
    packageInfo: { status: "ok", framework: "react", uiLibraries: ["tailwindcss", "@radix-ui"] },
  };

  test("renders fields we care about", () => {
    const out = renderContextScanSummary(scan);
    expect(out).toContain("Framework: react");
    expect(out).toContain("Tokens: tailwind");
    expect(out).toContain("Components: 2");
    expect(out).toContain("design.md");
    expect(out).toContain("tailwindcss");
  });

  test("reports missing fields explicitly", () => {
    const empty: ContextScan = {
      scannedAt: "2026-04-18T00:00:00.000Z",
      tokens: { status: "missing" },
      components: { status: "missing", items: [] },
      designMd: { status: "missing" },
      packageInfo: { status: "missing" },
    };
    const out = renderContextScanSummary(empty);
    expect(out).toContain("missing");
  });
});
