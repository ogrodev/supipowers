import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scanPenFiles } from "../../src/ui-design/pen-scanner.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-pen-scanner-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFile(rel: string, content: string): string {
  const abs = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

describe("scanPenFiles", () => {
  test("returns empty list when repoRoot does not exist", () => {
    expect(scanPenFiles(path.join(tmpDir, "missing"))).toEqual([]);
  });

  test("returns empty list when repoRoot is a file", () => {
    const file = writeFile("not-a-dir.pen", "x");
    expect(scanPenFiles(file)).toEqual([]);
  });

  test("discovers .pen files recursively and ignores other extensions", () => {
    writeFile("designs/home.pen", "abc");
    writeFile("nested/deep/checkout.pen", "defgh");
    writeFile("assets/logo.png", "x");
    writeFile("README.md", "x");

    const entries = scanPenFiles(tmpDir);
    expect(entries.map((e) => e.relativePath)).toEqual([
      "designs/home.pen",
      "nested/deep/checkout.pen",
    ]);
    const home = entries.find((e) => e.relativePath === "designs/home.pen")!;
    expect(home.absolutePath).toBe(path.join(tmpDir, "designs", "home.pen"));
    expect(home.bytes).toBe(3);
  });

  test("skips default-excluded directories", () => {
    writeFile("node_modules/pkg/design.pen", "x");
    writeFile("dist/bundle.pen", "x");
    writeFile("build/old.pen", "x");
    writeFile(".next/cache.pen", "x");
    writeFile(".cache/old.pen", "x");
    writeFile(".omp/supipowers/ui-design/session.pen", "x");
    writeFile(".git/objects/x.pen", "x");
    writeFile("designs/keep.pen", "x");

    const entries = scanPenFiles(tmpDir);
    expect(entries.map((e) => e.relativePath)).toEqual(["designs/keep.pen"]);
  });

  test("honors custom excludes", () => {
    writeFile("scratch/work.pen", "x");
    writeFile("designs/live.pen", "x");

    const entries = scanPenFiles(tmpDir, { excludes: ["scratch"] });
    expect(entries.map((e) => e.relativePath)).toEqual(["designs/live.pen"]);
  });

  test("caps results at `max`", () => {
    for (let i = 0; i < 10; i++) {
      writeFile(`d${i}/file.pen`, "x");
    }

    const entries = scanPenFiles(tmpDir, { max: 3 });
    expect(entries.length).toBe(3);
  });

  test("sorts results deterministically by relative path", () => {
    writeFile("z/one.pen", "x");
    writeFile("a/two.pen", "x");
    writeFile("m/three.pen", "x");

    const entries = scanPenFiles(tmpDir);
    expect(entries.map((e) => e.relativePath)).toEqual([
      "a/two.pen",
      "m/three.pen",
      "z/one.pen",
    ]);
  });
});
