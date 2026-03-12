import { describe, test, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  saveSpec,
  readSpec,
  listSpecs,
  getSpecsDir,
} from "../../src/storage/specs.js";

describe("specs storage", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-specs-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("saveSpec creates the specs directory and writes the file", () => {
    const content = "# My Design\n\nSome spec content";
    const filename = "2026-03-12-auth-design.md";

    const filePath = saveSpec(tmpDir, filename, content);

    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, "utf-8")).toBe(content);
    expect(filePath).toContain(filename);
  });

  test("saveSpec stores files under docs/supipowers/specs/", () => {
    const filePath = saveSpec(tmpDir, "test-spec.md", "content");
    const relative = path.relative(tmpDir, filePath);
    expect(relative).toBe(path.join("docs", "supipowers", "specs", "test-spec.md"));
  });

  test("readSpec returns file content", () => {
    saveSpec(tmpDir, "my-spec.md", "hello world");
    const content = readSpec(tmpDir, "my-spec.md");
    expect(content).toBe("hello world");
  });

  test("readSpec returns null for non-existent file", () => {
    const content = readSpec(tmpDir, "nonexistent.md");
    expect(content).toBeNull();
  });

  test("listSpecs returns all .md files sorted newest first", () => {
    saveSpec(tmpDir, "2026-01-01-first.md", "a");
    saveSpec(tmpDir, "2026-03-01-second.md", "b");
    saveSpec(tmpDir, "2026-02-01-third.md", "c");

    const specs = listSpecs(tmpDir);
    expect(specs).toEqual([
      "2026-03-01-second.md",
      "2026-02-01-third.md",
      "2026-01-01-first.md",
    ]);
  });

  test("listSpecs returns empty array when no specs directory", () => {
    const specs = listSpecs(tmpDir);
    expect(specs).toEqual([]);
  });

  test("getSpecsDir returns the correct path", () => {
    const dir = getSpecsDir(tmpDir);
    expect(dir).toBe(path.join(tmpDir, "docs", "supipowers", "specs"));
  });
});
