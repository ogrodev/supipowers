import { describe, it, expect } from "vitest";
import { formatCheckResult, formatSummary } from "../../src/commands/doctor.js";

describe("doctor formatting", () => {
  it("formats a passing two-phase check", () => {
    const result = {
      name: "Git",
      presence: { ok: true, detail: "v2.43.0" },
      functional: { ok: true, detail: "Repo detected (main)" },
    };
    const lines = formatCheckResult(result);
    expect(lines).toEqual([
      "  Git .............. ✓ v2.43.0",
      "                     ✓ Repo detected (main)",
    ]);
  });

  it("formats a failing presence check with no functional", () => {
    const result = {
      name: "GitHub CLI",
      presence: { ok: false, detail: "not found" },
    };
    const lines = formatCheckResult(result);
    expect(lines).toEqual([
      "  GitHub CLI ....... ✗ not found",
    ]);
  });

  it("formats a presence-only passing check", () => {
    const result = {
      name: "LSP",
      presence: { ok: true, detail: "LSP tools detected" },
    };
    const lines = formatCheckResult(result);
    expect(lines).toEqual([
      "  LSP .............. ✓ LSP tools detected",
    ]);
  });

  it("formats presence pass + functional fail", () => {
    const result = {
      name: "npm",
      presence: { ok: true, detail: "v10.8.0" },
      functional: { ok: false, detail: "Registry unreachable" },
    };
    const lines = formatCheckResult(result);
    expect(lines).toEqual([
      "  npm .............. ✓ v10.8.0",
      "                     ✗ Registry unreachable",
    ]);
  });

  it("counts core infra presence failures as critical", () => {
    const sections = [
      {
        title: "Core Infrastructure",
        checks: [
          { name: "Platform", presence: { ok: true, detail: "" }, functional: { ok: true, detail: "" } },
          { name: "Config", presence: { ok: true, detail: "" }, functional: { ok: false, detail: "" } },
          { name: "Git", presence: { ok: false, detail: "" } },
        ],
      },
      {
        title: "Integrations",
        checks: [
          { name: "npm", presence: { ok: false, detail: "" } },
        ],
      },
    ];
    const summary = formatSummary(sections);
    expect(summary).toContain("1 passed");
    expect(summary).toContain("2 warnings"); // Config functional fail + npm presence fail
    expect(summary).toContain("1 critical"); // Git presence fail is critical (core infra)
  });
});
