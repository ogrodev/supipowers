import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  JSON_INVARIANT,
  jsonContentSniff,
  jsonProcessor,
} from "../../../src/context-mode/processors/json.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(__dirname, "fixtures", "json");
const encoder = new TextEncoder();

function fixture(name: string): string {
  return fs.readFileSync(path.join(fixtureDir, name), "utf-8");
}

function process(text: string) {
  return jsonProcessor(text, { exitCode: 0, eol: text.includes("\r\n") ? "\r\n" : "\n" });
}

function expectUnderBudget(text: string): void {
  expect(encoder.encode(text).byteLength).toBeLessThanOrEqual(JSON_INVARIANT.maxBytes);
}

describe("json processor", () => {
  test("jsonContentSniff accepts parseable objects and arrays and rejects malformed JSON", () => {
    expect(jsonContentSniff(fixture("object-small.txt"))).toBe(true);
    expect(jsonContentSniff(fixture("array-large-posix.txt"))).toBe(true);
    expect(jsonContentSniff("{ not valid json")).toBe(false);
    expect(jsonContentSniff("plain text")).toBe(false);
  });

  test("object summary preserves top-level keys and aggregate counts", () => {
    const output = process(fixture("object-large-posix.txt"));

    expect(output.processorKey).toBe("json");
    expect(output.passthrough).toBe(false);
    expect(output.text).toContain("type: object");
    expect(output.text).toContain("topLevelKeys (7): name, version, enabled, dependencies, scripts, workspaces, metadata");
    expect(output.text).toContain("dependencies: object(keys=3)");
    expect(output.text).toContain("workspaces: array(items=6)");
    expectUnderBudget(output.text);
  });

  test("array summary preserves first five elements and counts", () => {
    const output = process(fixture("array-large-posix.txt"));

    expect(output.text).toContain("type: array");
    expect(output.text).toContain("items: 7");
    expect(output.text).toContain("[0]: {id, name, status}");
    expect(output.text).toContain("[4]: {id, name, status}");
    expect(output.text).not.toContain("[5]:");
    expectUnderBudget(output.text);
  });

  test("nested objects are summarized by top-level key", () => {
    const output = process(fixture("nested-large-posix.txt"));

    expect(output.text).toContain("service: object(keys=3)");
    expect(output.text).toContain("deployment: object(keys=2)");
    expect(output.text).toContain("observability: object(keys=2)");
  });

  test("preserves CRLF style", () => {
    const output = process(fixture("nested-large-crlf.txt"));
    expect(output.text).toContain("\r\n");
  });

  test("is deterministic", () => {
    const input = fixture("object-large-crlf.txt");
    expect(process(input).text).toBe(process(input).text);
  });

  test("returns passthrough on parse failure", () => {
    const input = "{ broken";
    expect(jsonProcessor(input, { exitCode: 0, eol: "\n" })).toEqual({
      text: input,
      processorKey: "json",
      passthrough: true,
    });
  });
});
