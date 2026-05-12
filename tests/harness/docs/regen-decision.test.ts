import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  attachProvenance,
  computeBodyContentHash,
} from "../../../src/harness/docs/provenance.js";
import { decideRegenSet } from "../../../src/harness/docs/regen-decision.js";
import { getHarnessRepoDocsLayerPath } from "../../../src/harness/project-paths.js";
import { createTestPaths } from "../../ultraplan/fixtures.js";
import type { HarnessLayerRule } from "../../../src/types.js";

let tmp: string;
let cwd: string;
let paths: ReturnType<typeof createTestPaths>;

const LIB_LAYER: HarnessLayerRule = {
  layer: "lib",
  globs: ["src/lib/**"],
  allowedImports: [],
  forbiddenImports: [],
};
const APP_LAYER: HarnessLayerRule = {
  layer: "app",
  globs: ["src/app/**"],
  allowedImports: ["lib"],
  forbiddenImports: [],
};

const SOURCE_HASH_LIB = "a".repeat(64);
const SOURCE_HASH_APP = "b".repeat(64);

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "supi-docs-regen-"));
  cwd = path.join(tmp, "repo");
  fs.mkdirSync(cwd, { recursive: true });
  paths = createTestPaths(tmp);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeDoc(layer: string, opts: {
  sourceHash?: string;
  bodySuffix?: string;
  unmarked?: boolean;
  hashOverride?: string;
}): string {
  const layerPath = getHarnessRepoDocsLayerPath(paths, cwd, layer);
  fs.mkdirSync(path.dirname(layerPath), { recursive: true });
  const body = [
    "---",
    `layer: ${layer}`,
    "generatedAt: 2026-05-12T12:00:00.000Z",
    `sourceHash: ${opts.sourceHash ?? "a".repeat(64)}`,
    "---",
    "## Agent context",
    "context",
    "## Purpose",
    "purpose",
    "## Files",
    "files",
    "## Imports",
    "imports",
    "## Conventions",
    "conventions",
    "",
  ].join("\n") + (opts.bodySuffix ?? "");

  const doc = opts.unmarked
    ? body
    : attachProvenance(body, {
        sessionId: "harness-test-deadbeef",
        generatedAt: "2026-05-12T12:00:00.000Z",
        contentHash: opts.hashOverride ?? computeBodyContentHash(body),
      });

  fs.writeFileSync(layerPath, doc);
  return layerPath;
}

describe("decideRegenSet", () => {
  test("missing doc → regen", () => {
    const result = decideRegenSet({
      paths,
      cwd,
      layers: [LIB_LAYER],
      expectedSourceHashes: new Map([["lib", SOURCE_HASH_LIB]]),
    });
    expect(result.regen).toEqual(["lib"]);
    expect(result.skip).toEqual([]);
    expect(result.userEdited).toEqual([]);
    expect(result.entries[0].reason).toBe("doc missing");
  });

  test("matching source hash → skip", () => {
    writeDoc("lib", { sourceHash: SOURCE_HASH_LIB });
    const result = decideRegenSet({
      paths,
      cwd,
      layers: [LIB_LAYER],
      expectedSourceHashes: new Map([["lib", SOURCE_HASH_LIB]]),
    });
    expect(result.regen).toEqual([]);
    expect(result.skip).toEqual(["lib"]);
    expect(result.userEdited).toEqual([]);
  });

  test("sourceHash mismatch → regen", () => {
    writeDoc("lib", { sourceHash: "old-hash" });
    const result = decideRegenSet({
      paths,
      cwd,
      layers: [LIB_LAYER],
      expectedSourceHashes: new Map([["lib", SOURCE_HASH_LIB]]),
    });
    expect(result.regen).toEqual(["lib"]);
    expect(result.entries[0].reason).toBe("frontmatter sourceHash does not match expected (inputs changed)");
  });

  test("user-edited body → userEdited", () => {
    // Write a doc, then append text after marker emit. content-hash mismatch.
    const docPath = writeDoc("lib", { sourceHash: SOURCE_HASH_LIB });
    fs.appendFileSync(docPath, "\nuser added section\n");
    const result = decideRegenSet({
      paths,
      cwd,
      layers: [LIB_LAYER],
      expectedSourceHashes: new Map([["lib", SOURCE_HASH_LIB]]),
    });
    expect(result.regen).toEqual([]);
    expect(result.skip).toEqual([]);
    expect(result.userEdited).toEqual(["lib"]);
    expect(result.entries[0].reason).toContain("body hash differs");
  });

  test("doc without marker → userEdited (unmarked)", () => {
    writeDoc("lib", { unmarked: true, sourceHash: SOURCE_HASH_LIB });
    const result = decideRegenSet({
      paths,
      cwd,
      layers: [LIB_LAYER],
      expectedSourceHashes: new Map([["lib", SOURCE_HASH_LIB]]),
    });
    expect(result.userEdited).toEqual(["lib"]);
    expect(result.entries[0].reason).toContain("no harness-docs marker");
  });

  test("mixed bucket: regen + skip + userEdited", () => {
    writeDoc("lib", { sourceHash: SOURCE_HASH_LIB }); // intact
    const appPath = writeDoc("app", { sourceHash: SOURCE_HASH_APP });
    fs.appendFileSync(appPath, "\nhand-edit\n");
    const result = decideRegenSet({
      paths,
      cwd,
      layers: [LIB_LAYER, APP_LAYER, { ...LIB_LAYER, layer: "infra" }],
      expectedSourceHashes: new Map([
        ["lib", SOURCE_HASH_LIB],
        ["app", SOURCE_HASH_APP],
        ["infra", "c".repeat(64)],
      ]),
    });
    expect(result.skip).toEqual(["lib"]);
    expect(result.userEdited).toEqual(["app"]);
    expect(result.regen).toEqual(["infra"]);
  });

  test("missing expected hash → regen with note", () => {
    writeDoc("lib", { sourceHash: SOURCE_HASH_LIB });
    const result = decideRegenSet({
      paths,
      cwd,
      layers: [LIB_LAYER],
      expectedSourceHashes: new Map(),
    });
    expect(result.regen).toEqual(["lib"]);
    expect(result.entries[0].reason).toBe("no expected source hash supplied");
  });
});
