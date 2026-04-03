
import { getActiveGates, createReviewReport } from "../../src/quality/gate-runner.js";
import { BUILTIN_PROFILES } from "../../src/config/defaults.js";

describe("getActiveGates", () => {
  test("quick profile enables lsp and ai-review only", () => {
    const gates = getActiveGates(BUILTIN_PROFILES["quick"], true);
    expect(gates).toContain("lsp-diagnostics");
    expect(gates).toContain("ai-review");
    expect(gates).not.toContain("test-suite");
  });

  test("full-regression enables all gates", () => {
    const gates = getActiveGates(BUILTIN_PROFILES["full-regression"], true);
    expect(gates).toContain("lsp-diagnostics");
    expect(gates).toContain("ai-review");
    expect(gates).toContain("code-quality");
    expect(gates).toContain("test-suite");
    expect(gates).toContain("e2e");
  });

  test("skips lsp gate when lsp not available", () => {
    const gates = getActiveGates(BUILTIN_PROFILES["thorough"], false);
    expect(gates).not.toContain("lsp-diagnostics");
    expect(gates).toContain("ai-review");
  });
});

describe("createReviewReport", () => {
  test("report passes when all gates pass", () => {
    const report = createReviewReport("quick", [
      { gate: "lsp", passed: true, issues: [] },
      { gate: "ai-review", passed: true, issues: [] },
    ]);
    expect(report.passed).toBe(true);
  });

  test("report fails when any gate fails", () => {
    const report = createReviewReport("thorough", [
      { gate: "lsp", passed: true, issues: [] },
      { gate: "ai-review", passed: false, issues: [{ severity: "error", message: "bug" }] },
    ]);
    expect(report.passed).toBe(false);
  });
});
