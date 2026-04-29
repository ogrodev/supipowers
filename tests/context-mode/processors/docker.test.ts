import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DOCKER_INVARIANT, dockerProcessor } from "../../../src/context-mode/processors/docker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(__dirname, "fixtures", "docker");
const encoder = new TextEncoder();

function fixture(name: string): string {
  return fs.readFileSync(path.join(fixtureDir, name), "utf-8");
}

function process(text: string) {
  return dockerProcessor(text, { exitCode: 0, eol: text.includes("\r\n") ? "\r\n" : "\n" });
}

function expectUnderBudget(text: string): void {
  expect(encoder.encode(text).byteLength).toBeLessThanOrEqual(DOCKER_INVARIANT.maxBytes);
}

describe("dockerProcessor", () => {
  test("ps output preserves table headers, ids, names, and statuses", () => {
    const output = process(fixture("ps-large-posix.txt"));
    expect(output.processorKey).toBe("docker");
    expect(output.text).toContain("CONTAINER ID   IMAGE");
    expect(output.text).toContain("abc123def456");
    expect(output.text).toContain("api-1");
    expect(output.text).toContain("Restarting (1) 5s ago");
    expectUnderBudget(output.text);
  });

  test("images output preserves first-12 image ids", () => {
    const output = process(fixture("images-large-posix.txt"));
    expect(output.text).toContain("IMAGE ID");
    expect(output.text).toContain("abc123def456");
    expect(output.text).toContain("fedcba987654");
    expectUnderBudget(output.text);
  });

  test("logs output preserves last 20 lines", () => {
    const output = process(fixture("logs-large-posix.txt"));
    expect(output.text).toContain("log 06 request");
    expect(output.text).toContain("log 25 request");
    expect(output.text).not.toContain("log 05 request");
    expectUnderBudget(output.text);
  });

  test("build output preserves failure status", () => {
    const output = process(fixture("build-large-posix.txt"));
    expect(output.text).toContain("ERROR: failed to solve");
    expect(output.text).toContain("exit code: 1");
    expectUnderBudget(output.text);
  });

  test("preserves CRLF and determinism", () => {
    const input = fixture("ps-large-crlf.txt");
    expect(process(input).text).toBe(process(input).text);
    expect(process(input).text).toContain("\r\n");
  });

  test("unrelated text returns passthrough", () => {
    const input = "plain output";
    expect(dockerProcessor(input, { exitCode: 0, eol: "\n" })).toEqual({
      text: input,
      processorKey: "docker",
      passthrough: true,
    });
  });
});
