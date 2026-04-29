import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TEST_RUNNER_INVARIANT,
  testRunnerProcessor,
} from "../../../src/context-mode/processors/test-runner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(__dirname, "fixtures", "test-runner");
const encoder = new TextEncoder();

function fixture(name: string): string {
  return fs.readFileSync(path.join(fixtureDir, name), "utf-8");
}

function process(text: string) {
  return testRunnerProcessor(text, { exitCode: 1, eol: text.includes("\r\n") ? "\r\n" : "\n" });
}

function expectUnderBudget(text: string): void {
  expect(encoder.encode(text).byteLength).toBeLessThanOrEqual(TEST_RUNNER_INVARIANT.maxBytes);
}

describe("testRunnerProcessor", () => {
  test.each(["bun-fail-large-posix.txt", "vitest-fail-large-posix.txt", "jest-fail-large-posix.txt"])(
    "preserves failure labels, stack locations, and summaries for %s",
    (name) => {
      const output = process(fixture(name));

      expect(output.processorKey).toBe("test");
      expect(output.passthrough).toBe(false);
      expect(output.text).toMatch(/FAIL|fail/);
      expect(output.text).toMatch(/PASS|pass/);
      expect(output.text).toMatch(/tests\/.+\.test\.[tj]sx?:\d+:\d+/);
      expect(output.text).toMatch(/Ran|Tests:|Test Files|fail/);
      expectUnderBudget(output.text);
    },
  );

  test("large passing run emits summary without every passing file", () => {
    const output = testRunnerProcessor(fixture("bun-pass-large-posix.txt"), { exitCode: 0, eol: "\n" });

    expect(output.text).toContain("10 pass");
    expect(output.text).toContain("Ran 10 tests across 10 files");
    expect(output.text).not.toContain("tests/unit/pass-001.test.ts");
    expectUnderBudget(output.text);
  });

  test("preserves CRLF style", () => {
    const output = process(fixture("vitest-fail-large-crlf.txt"));
    expect(output.text).toContain("\r\n");
  });

  test("returns passthrough when no test tokens exist", () => {
    const input = "plain command output\nwithout runner tokens";
    expect(testRunnerProcessor(input, { exitCode: 0, eol: "\n" })).toEqual({
      text: input,
      processorKey: "test",
      passthrough: true,
    });
  });

  test("identical input is deterministic", () => {
    const input = fixture("bun-fail-large-crlf.txt");
    const first = process(input);
    const second = process(input);
    expect(first.text).toBe(second.text);
  });
});
