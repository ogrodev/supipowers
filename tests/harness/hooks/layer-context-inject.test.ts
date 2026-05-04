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
    expect(result.reason).toBe("matched");
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
});
