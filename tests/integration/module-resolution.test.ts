import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const PRODUCTION_ROOTS = ["src", "bin"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const IGNORED_DIRS = new Set(["node_modules", "dist", ".git"]);

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(fullPath, out);
      continue;
    }

    if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(fullPath);
    }
  }

  return out;
}

describe("module resolution guardrails", () => {
  test("production code does not use relative dynamic imports", () => {
    const offenders = PRODUCTION_ROOTS.flatMap((root) => collectSourceFiles(root))
      .flatMap((filePath) => {
        const source = fs.readFileSync(filePath, "utf-8");
        const matches = source.matchAll(/\bimport\s*\(\s*(["'`])\.\.?\//g);
        return [...matches].map((match) => `${filePath}:${match.index ?? 0}`);
      });

    expect(offenders).toEqual([]);
  });
});
