import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { BUILD_INVARIANT, buildProcessor } from "../../../src/context-mode/processors/build.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(__dirname, "fixtures", "build");
const encoder = new TextEncoder();

function fixture(name: string): string {
  return fs.readFileSync(path.join(fixtureDir, name), "utf-8");
}

function process(text: string) {
  return buildProcessor(text, { exitCode: 1, eol: text.includes("\r\n") ? "\r\n" : "\n" });
}

function expectUnderBudget(text: string): void {
  expect(encoder.encode(text).byteLength).toBeLessThanOrEqual(BUILD_INVARIANT.maxBytes);
}

describe("buildProcessor", () => {
  test.each(["tsc-large-posix.txt", "cargo-large-posix.txt", "go-large-posix.txt", "esbuild-large-posix.txt"])(
    "preserves build diagnostics and summary for %s",
    (name) => {
      const output = process(fixture(name));
      expect(output.processorKey).toBe("build");
      expect(output.passthrough).toBe(false);
      expect(output.text).toMatch(/error|ERROR|FAIL|failed/i);
      expect(output.text).toMatch(/\.ts\(|\.rs:|\.go:|src\/index\.ts:3:20/);
      expectUnderBudget(output.text);
    },
  );

  test("preserves CRLF style and deterministic output", () => {
    const input = fixture("tsc-large-crlf.txt");
    const first = process(input);
    const second = process(input);
    expect(first.text).toBe(second.text);
    expect(first.text).toContain("\r\n");
  });

  test("no error shape returns passthrough", () => {
    const input = "Build completed successfully in 120ms";
    expect(buildProcessor(input, { exitCode: 0, eol: "\n" })).toEqual({
      text: input,
      processorKey: "build",
      passthrough: true,
    });
  });
});
