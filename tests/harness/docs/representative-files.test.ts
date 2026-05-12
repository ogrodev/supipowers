import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  renderRepresentativeBlock,
  selectRepresentativeFiles,
} from "../../../src/harness/docs/representative-files.js";

let tmp: string;

function makeLines(n: number, prefix: string): string {
  const lines: string[] = [];
  for (let i = 0; i < n; i += 1) lines.push(`${prefix} line ${i}`);
  return lines.join("\n") + "\n";
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "supi-docs-repfiles-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("selectRepresentativeFiles", () => {
  test("orders by LOC desc, then path asc", () => {
    const small = path.join(tmp, "small.ts");
    const medium = path.join(tmp, "medium.ts");
    const large = path.join(tmp, "large.ts");
    fs.writeFileSync(small, makeLines(5, "s"));
    fs.writeFileSync(medium, makeLines(20, "m"));
    fs.writeFileSync(large, makeLines(100, "l"));

    const result = selectRepresentativeFiles({
      cwd: tmp,
      files: ["small.ts", "large.ts", "medium.ts"],
    });
    expect(result.entries.map((e) => e.path)).toEqual([
      "large.ts",
      "medium.ts",
      "small.ts",
    ]);
  });

  test("path ties broken by ascending path", () => {
    fs.writeFileSync(path.join(tmp, "b.ts"), makeLines(10, "b"));
    fs.writeFileSync(path.join(tmp, "a.ts"), makeLines(10, "a"));
    fs.writeFileSync(path.join(tmp, "c.ts"), makeLines(10, "c"));

    const result = selectRepresentativeFiles({ cwd: tmp, files: ["b.ts", "c.ts", "a.ts"] });
    expect(result.entries.map((e) => e.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  test("caps at topN", () => {
    fs.writeFileSync(path.join(tmp, "a.ts"), makeLines(5, "a"));
    fs.writeFileSync(path.join(tmp, "b.ts"), makeLines(15, "b"));
    fs.writeFileSync(path.join(tmp, "c.ts"), makeLines(25, "c"));

    const result = selectRepresentativeFiles({
      cwd: tmp,
      files: ["a.ts", "b.ts", "c.ts"],
      topN: 2,
    });
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].path).toBe("c.ts");
  });

  test("samples head LOC and appends … when truncated", () => {
    fs.writeFileSync(path.join(tmp, "big.ts"), makeLines(200, "x"));
    const result = selectRepresentativeFiles({
      cwd: tmp,
      files: ["big.ts"],
      headLoc: 10,
    });
    const sample = result.entries[0].sample;
    expect(sample.endsWith("…\n")).toBe(true);
    // Header + 10 lines retained
    expect(sample.split("\n").filter((l) => l.startsWith("x line ")).length).toBe(10);
  });

  test("does not truncate when the file fits in headLoc", () => {
    fs.writeFileSync(path.join(tmp, "tiny.ts"), makeLines(3, "y"));
    const result = selectRepresentativeFiles({
      cwd: tmp,
      files: ["tiny.ts"],
      headLoc: 80,
    });
    expect(result.entries[0].sample.includes("…")).toBe(false);
  });

  test("byte cap drops tail entries beyond the cap", () => {
    fs.writeFileSync(path.join(tmp, "a.ts"), makeLines(100, "a")); // largest
    fs.writeFileSync(path.join(tmp, "b.ts"), makeLines(80, "b"));
    fs.writeFileSync(path.join(tmp, "c.ts"), makeLines(60, "c"));

    const result = selectRepresentativeFiles({
      cwd: tmp,
      files: ["a.ts", "b.ts", "c.ts"],
      headLoc: 80,
      bundleBytesCap: 1, // forces drop after the first entry
    });
    expect(result.entries.map((e) => e.path)).toEqual(["a.ts"]);
  });

  test("records unreadable files but does not throw", () => {
    fs.writeFileSync(path.join(tmp, "a.ts"), makeLines(2, "a"));
    const result = selectRepresentativeFiles({
      cwd: tmp,
      files: ["a.ts", "does-not-exist.ts"],
    });
    expect(result.unreadable).toEqual(["does-not-exist.ts"]);
    expect(result.entries.map((e) => e.path)).toEqual(["a.ts"]);
  });

  test("computes a stable content hash per entry", () => {
    fs.writeFileSync(path.join(tmp, "a.ts"), "content\n");
    const result = selectRepresentativeFiles({ cwd: tmp, files: ["a.ts"] });
    expect(result.entries[0].contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("renderRepresentativeBlock", () => {
  test("formats with --- path --- headers", () => {
    const block = renderRepresentativeBlock([
      { path: "src/lib/a.ts", loc: 10, sample: "a body\n", contentHash: "h1" },
      { path: "src/lib/b.ts", loc: 8, sample: "b body\n", contentHash: "h2" },
    ]);
    expect(block).toContain("--- src/lib/a.ts ---");
    expect(block).toContain("--- src/lib/b.ts ---");
    expect(block).toContain("a body");
    expect(block).toContain("b body");
  });

  test("returns a placeholder string when empty", () => {
    expect(renderRepresentativeBlock([])).toBe("(no representative files)");
  });
});
