import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  _resetLayerRuleCacheForTests,
  computeLayerAddendum,
} from "../../../src/harness/hooks/layer-context-inject.js";

let tmpDir: string;
let archPath: string;

beforeEach(() => {
  _resetLayerRuleCacheForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-harness-layerhook-"));
  archPath = path.join(tmpDir, "docs", "architecture.md");
  fs.mkdirSync(path.dirname(archPath), { recursive: true });
  fs.writeFileSync(
    archPath,
    [
      "# Architecture",
      "",
      "| Layer | Files | Allowed | Forbidden |",
      "|---|---|---|---|",
      "| domain | `src/domain/**` | domain | infra |",
      "",
    ].join("\n"),
  );
});

afterEach(() => {
  _resetLayerRuleCacheForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("computeLayerAddendum", () => {
  test("disabled config short-circuits", () => {
    const result = computeLayerAddendum({
      cwd: tmpDir,
      candidateFile: "src/domain/user.ts",
      config: { enabled: false, addendum_max_chars: 800 },
      archPath,
    });
    expect(result.addendum).toBe("");
    expect(result.reason).toBe("disabled");
  });

  test("returns addendum for matching file", () => {
    const result = computeLayerAddendum({
      cwd: tmpDir,
      candidateFile: "src/domain/user.ts",
      config: { enabled: true, addendum_max_chars: 800 },
      archPath,
    });
    expect(result.addendum).toContain("domain");
    expect(result.addendum).toContain("Permitted imports: domain");
    expect(result.reason).toBe("matched (architecture.md fallback)");
  });

  test("no candidate → no-op", () => {
    const result = computeLayerAddendum({
      cwd: tmpDir,
      candidateFile: null,
      config: { enabled: true, addendum_max_chars: 800 },
      archPath,
    });
    expect(result.addendum).toBe("");
  });

  test("no rule match → no addendum", () => {
    const result = computeLayerAddendum({
      cwd: tmpDir,
      candidateFile: "scripts/deploy.ts",
      config: { enabled: true, addendum_max_chars: 800 },
      archPath,
    });
    expect(result.addendum).toBe("");
    expect(result.reason).toContain("no rule");
  });

  test("missing arch doc → no-op", () => {
    const result = computeLayerAddendum({
      cwd: tmpDir,
      candidateFile: "src/domain/user.ts",
      config: { enabled: true, addendum_max_chars: 800 },
      archPath: "/nonexistent/path/architecture.md",
    });
    expect(result.addendum).toBe("");
    expect(result.reason).toContain("no rules parsed");
  });

  test("addendum truncated at max_chars", () => {
    const result = computeLayerAddendum({
      cwd: tmpDir,
      candidateFile: "src/domain/user.ts",
      config: { enabled: true, addendum_max_chars: 40 },
      archPath,
    });
    expect(result.addendum.length).toBeLessThanOrEqual(40);
    expect(result.addendum.endsWith("…")).toBe(true);
  });

  test("prefers per-layer doc Agent context section when present", () => {
    const layerDocPath = path.join(tmpDir, "docs", "layers", "domain.md");
    fs.mkdirSync(path.dirname(layerDocPath), { recursive: true });
    const layerDocBody = [
      "---",
      "layer: domain",
      "generatedAt: 2026-05-12T12:00:00.000Z",
      "sourceHash: " + "a".repeat(64),
      "---",
      "## Agent context",
      "Crisp per-layer agent context.",
      "Don't import infra.",
      "## Purpose",
      "domain layer.",
    ].join("\n");
    fs.writeFileSync(layerDocPath, layerDocBody);

    const result = computeLayerAddendum({
      cwd: tmpDir,
      candidateFile: "src/domain/user.ts",
      config: { enabled: true, addendum_max_chars: 800 },
      archPath,
    });
    expect(result.addendum).toContain("Crisp per-layer agent context.");
    expect(result.addendum).toContain("Don't import infra.");
    expect(result.reason).toBe("matched (per-layer doc)");
  });

  test("per-layer doc agent-context section respects max_chars cap", () => {
    const layerDocPath = path.join(tmpDir, "docs", "layers", "domain.md");
    fs.mkdirSync(path.dirname(layerDocPath), { recursive: true });
    const body = [
      "---",
      "layer: domain",
      "generatedAt: 2026-05-12T12:00:00.000Z",
      "sourceHash: deadbeef",
      "---",
      "## Agent context",
      "a".repeat(2000),
      "## Purpose",
      "p",
    ].join("\n");
    fs.writeFileSync(layerDocPath, body);

    const result = computeLayerAddendum({
      cwd: tmpDir,
      candidateFile: "src/domain/user.ts",
      config: { enabled: true, addendum_max_chars: 40 },
      archPath,
    });
    expect(result.addendum.length).toBeLessThanOrEqual(40);
    expect(result.addendum.endsWith("…")).toBe(true);
    expect(result.reason).toBe("matched (per-layer doc)");
  });

  test("missing per-layer doc falls back to architecture.md", () => {
    const result = computeLayerAddendum({
      cwd: tmpDir,
      candidateFile: "src/domain/user.ts",
      config: { enabled: true, addendum_max_chars: 800 },
      archPath,
    });
    expect(result.addendum).toContain("Architecture context (from docs/architecture.md)");
    expect(result.reason).toBe("matched (architecture.md fallback)");
  });
});
