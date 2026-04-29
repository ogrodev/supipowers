import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { LINT_INVARIANT, lintProcessor } from "../../../src/context-mode/processors/lint.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(__dirname, "fixtures", "lint");
const encoder = new TextEncoder();

function fixture(name: string): string {
  return fs.readFileSync(path.join(fixtureDir, name), "utf-8");
}

function process(text: string) {
  return lintProcessor(text, { exitCode: 1, eol: text.includes("\r\n") ? "\r\n" : "\n" });
}

function expectUnderBudget(text: string): void {
  expect(encoder.encode(text).byteLength).toBeLessThanOrEqual(LINT_INVARIANT.maxBytes);
}

describe("lintProcessor", () => {
  test("preserves ESLint file/line/column diagnostics, severities, rules, and tally", () => {
    const output = process(fixture("eslint-large-posix.txt"));
    expect(output.processorKey).toBe("lint");
    expect(output.passthrough).toBe(false);
    for (const expected of ["/repo/src/a.ts", "1:7", "error", "no-unused-vars", "2:10", "warning", "no-console", "✖ 4 problems (2 errors, 2 warnings)"]) {
      expect(output.text).toContain(expected);
    }
    expectUnderBudget(output.text);
  });

  test("preserves Biome diagnostics and final tally", () => {
    const output = process(fixture("biome-large-posix.txt"));
    expect(output.text).toContain("src/a.ts:1:7");
    expect(output.text).toContain("lint/correctness/noUnusedVariables");
    expect(output.text).toContain("src/b.ts:5:3");
    expect(output.text).toContain("lint/style/useConst");
    expect(output.text).toContain("Found 1 error and 1 warning");
    expectUnderBudget(output.text);
  });

  test("preserves Prettier check warnings", () => {
    const output = process(fixture("prettier-large-posix.txt"));
    expect(output.text).toContain("[warn] src/a.ts");
    expect(output.text).toContain("[warn] src/b.ts");
    expect(output.text).toContain("Code style issues found in 2 files");
    expectUnderBudget(output.text);
  });

  test("preserves CRLF style and determinism", () => {
    const input = fixture("eslint-large-crlf.txt");
    const first = process(input);
    const second = process(input);
    expect(first.text).toBe(second.text);
    expect(first.text).toContain("\r\n");
  });

  test("no-diagnostic input returns passthrough", () => {
    const input = "Checked 10 files. No fixes applied.";
    expect(lintProcessor(input, { exitCode: 0, eol: "\n" })).toEqual({
      text: input,
      processorKey: "lint",
      passthrough: true,
    });
  });
});
