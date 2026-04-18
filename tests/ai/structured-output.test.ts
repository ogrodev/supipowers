import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import {
  collectValidationErrors,
  formatValidationErrors,
  parseStructuredOutput,
  runWithOutputValidation,
  type StructuredOutputResult,
} from "../../src/ai/structured-output.js";
import type { AgentSession } from "../../src/platform/types.js";

const PersonSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    age: Type.Integer(),
  },
  { additionalProperties: false },
);

interface Person {
  name: string;
  age: number;
}

describe("parseStructuredOutput", () => {
  test("parses valid JSON matching the schema", () => {
    const raw = '{"name":"Alice","age":30}';
    const result = parseStructuredOutput<Person>(raw, PersonSchema);
    expect(result.error).toBeNull();
    expect(result.output).toEqual({ name: "Alice", age: 30 });
  });

  test("strips markdown fences before parsing", () => {
    const raw = '```json\n{"name":"Bob","age":25}\n```';
    const result = parseStructuredOutput<Person>(raw, PersonSchema);
    expect(result.error).toBeNull();
    expect(result.output).toEqual({ name: "Bob", age: 25 });
  });

  test("returns error on invalid JSON", () => {
    const result = parseStructuredOutput<Person>("not json at all", PersonSchema);
    expect(result.output).toBeNull();
    expect(result.error).toContain("Invalid JSON");
  });

  test("returns error on schema mismatch with path info", () => {
    const raw = '{"name":"Carol","age":"thirty"}';
    const result = parseStructuredOutput<Person>(raw, PersonSchema);
    expect(result.output).toBeNull();
    expect(result.error).toContain("age");
  });

  test("rejects extra properties when additionalProperties is false", () => {
    const raw = '{"name":"Dan","age":40,"extra":true}';
    const result = parseStructuredOutput<Person>(raw, PersonSchema);
    expect(result.output).toBeNull();
    expect(result.error).not.toBeNull();
  });
});

describe("collectValidationErrors / formatValidationErrors", () => {
  test("returns empty list on valid data", () => {
    const errors = collectValidationErrors(PersonSchema, { name: "Ava", age: 22 });
    expect(errors).toEqual([]);
    expect(formatValidationErrors(errors)).toEqual([]);
  });

  test("reports path and message for invalid data", () => {
    const errors = collectValidationErrors(PersonSchema, { name: "", age: 1.5 });
    expect(errors.length).toBeGreaterThan(0);
    for (const err of errors) {
      expect(typeof err.path).toBe("string");
      expect(typeof err.message).toBe("string");
    }
  });

  test("formats errors as 'path: message' lines", () => {
    const errors = collectValidationErrors(PersonSchema, { age: "bad" });
    const lines = formatValidationErrors(errors);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/^[^:]+: .+/);
    }
  });
});

// ---------------------------------------------------------------------------
// runWithOutputValidation — retry-on-invalid-output loop
// ---------------------------------------------------------------------------

interface FakeSessionOptions {
  responses: Array<string | Error>;
  onPrompt?: (prompt: string, callIndex: number) => void;
}

function makeFakeSessionFactory(opts: FakeSessionOptions) {
  let callIndex = 0;
  const createAgentSession = async (_sessionOpts: any): Promise<AgentSession> => {
    const idx = callIndex;
    callIndex += 1;
    const messages: any[] = [];
    return {
      state: {
        get messages() {
          return messages;
        },
      },
      async prompt(prompt: string) {
        opts.onPrompt?.(prompt, idx);
        const next = opts.responses[idx];
        if (next instanceof Error) throw next;
        messages.push({ role: "assistant", content: next ?? "" });
      },
      async dispose() {
        // no-op
      },
    } as unknown as AgentSession;
  };
  return createAgentSession;
}

describe("runWithOutputValidation", () => {
  test("returns ok on first attempt when output is valid", async () => {
    const factory = makeFakeSessionFactory({
      responses: ['{"name":"Eve","age":28}'],
    });

    const result = (await runWithOutputValidation<Person>(factory as any, {
      cwd: "/tmp",
      prompt: "say hello",
      schema: "Person { name: string; age: integer }",
      parse: (raw) => parseStructuredOutput<Person>(raw, PersonSchema),
      maxAttempts: 3,
    })) as StructuredOutputResult<Person>;

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.attempts).toBe(1);
      expect(result.output).toEqual({ name: "Eve", age: 28 });
    }
  });

  test("retries with feedback prompt and succeeds on second attempt", async () => {
    const promptsSeen: string[] = [];
    const factory = makeFakeSessionFactory({
      responses: ["not json", '{"name":"Frank","age":33}'],
      onPrompt: (prompt) => {
        promptsSeen.push(prompt);
      },
    });

    const result = (await runWithOutputValidation<Person>(factory as any, {
      cwd: "/tmp",
      prompt: "give person",
      schema: "Person { name: string; age: integer }",
      parse: (raw) => parseStructuredOutput<Person>(raw, PersonSchema),
      maxAttempts: 3,
    })) as StructuredOutputResult<Person>;

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.attempts).toBe(2);
    }
    expect(promptsSeen.length).toBe(2);
    // Retry prompt contains the original prompt, the validation error, and the schema.
    expect(promptsSeen[1]).toContain("give person");
    expect(promptsSeen[1]).toContain("previous output was invalid");
    expect(promptsSeen[1]).toContain("Person { name: string; age: integer }");
  });

  test("returns blocked after maxAttempts when output stays invalid", async () => {
    const factory = makeFakeSessionFactory({
      responses: ["nope", "still no", "still not"],
    });

    const result = (await runWithOutputValidation<Person>(factory as any, {
      cwd: "/tmp",
      prompt: "give person",
      schema: "Person { name: string; age: integer }",
      parse: (raw) => parseStructuredOutput<Person>(raw, PersonSchema),
      maxAttempts: 3,
    })) as StructuredOutputResult<Person>;

    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.attempts).toBe(3);
      expect(result.rawOutputs.length).toBe(3);
      expect(result.error).toContain("Invalid JSON");
    }
  });

  test("returns blocked when the agent session errors", async () => {
    const factory = makeFakeSessionFactory({
      responses: [new Error("model unavailable")],
    });

    const result = (await runWithOutputValidation<Person>(factory as any, {
      cwd: "/tmp",
      prompt: "give person",
      schema: "Person",
      parse: (raw) => parseStructuredOutput<Person>(raw, PersonSchema),
      maxAttempts: 3,
    })) as StructuredOutputResult<Person>;

    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.attempts).toBe(1);
      expect(result.error).toContain("model unavailable");
    }
  });

  test("clamps maxAttempts to at least 1", async () => {
    const factory = makeFakeSessionFactory({
      responses: ['{"name":"Gina","age":18}'],
    });

    const result = (await runWithOutputValidation<Person>(factory as any, {
      cwd: "/tmp",
      prompt: "p",
      schema: "Person",
      parse: (raw) => parseStructuredOutput<Person>(raw, PersonSchema),
      maxAttempts: 0,
    })) as StructuredOutputResult<Person>;

    expect(result.status).toBe("ok");
  });
});


// ---------------------------------------------------------------------------
// runWithOutputValidation — ReliabilityReporter emission
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { createPaths } from "../../src/platform/types.js";
import type { ReliabilityRecord } from "../../src/types.js";

function mkTempCwd(): string {
  return fs.mkdtempSync(nodePath.join(os.tmpdir(), "supi-reliability-"));
}

function readRecords(cwd: string, dotDir = ".omp"): ReliabilityRecord[] {
  const file = nodePath.join(cwd, dotDir, "supipowers", "reliability", "events.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ReliabilityRecord);
}

describe("runWithOutputValidation — reliability reporter", () => {
  test("emits ok record on first-attempt success", async () => {
    const cwd = mkTempCwd();
    const paths = createPaths(".omp");
    const factory = makeFakeSessionFactory({
      responses: ['{"name":"Ada","age":30}'],
    });

    await runWithOutputValidation<Person>(factory as any, {
      cwd,
      prompt: "p",
      schema: "Person",
      parse: (raw) => parseStructuredOutput<Person>(raw, PersonSchema),
      reliability: { paths, cwd, command: "test", operation: "ok-path" },
    });

    const records = readRecords(cwd);
    expect(records).toHaveLength(1);
    expect(records[0]!.outcome).toBe("ok");
    expect(records[0]!.attempts).toBe(1);
    expect(records[0]!.command).toBe("test");
    expect(records[0]!.operation).toBe("ok-path");
    expect(records[0]!.reason).toBeUndefined();
  });

  test("emits retry-exhausted record when schema never validates", async () => {
    const cwd = mkTempCwd();
    const paths = createPaths(".omp");
    const factory = makeFakeSessionFactory({
      responses: ["nope", "still no", "still not"],
    });

    await runWithOutputValidation<Person>(factory as any, {
      cwd,
      prompt: "p",
      schema: "Person",
      parse: (raw) => parseStructuredOutput<Person>(raw, PersonSchema),
      maxAttempts: 3,
      reliability: { paths, cwd, command: "test", operation: "retry-path" },
    });

    const records = readRecords(cwd);
    expect(records).toHaveLength(1);
    expect(records[0]!.outcome).toBe("retry-exhausted");
    expect(records[0]!.attempts).toBe(3);
    expect(records[0]!.reason).toContain("Invalid JSON");
  });

  test("emits agent-error record when the agent session errors", async () => {
    const cwd = mkTempCwd();
    const paths = createPaths(".omp");
    const factory = makeFakeSessionFactory({
      responses: [new Error("model unavailable")],
    });

    await runWithOutputValidation<Person>(factory as any, {
      cwd,
      prompt: "p",
      schema: "Person",
      parse: (raw) => parseStructuredOutput<Person>(raw, PersonSchema),
      reliability: { paths, cwd, command: "test", operation: "agent-path" },
    });

    const records = readRecords(cwd);
    expect(records).toHaveLength(1);
    expect(records[0]!.outcome).toBe("agent-error");
    expect(records[0]!.attempts).toBe(1);
    expect(records[0]!.reason).toContain("model unavailable");
  });

  test("emits agent-error and re-throws when createAgentSession itself throws", async () => {
    const cwd = mkTempCwd();
    const paths = createPaths(".omp");
    const throwingFactory = async () => {
      throw new Error("session factory boom");
    };

    let caught: Error | null = null;
    try {
      await runWithOutputValidation<Person>(throwingFactory as any, {
        cwd,
        prompt: "p",
        schema: "Person",
        parse: (raw) => parseStructuredOutput<Person>(raw, PersonSchema),
        reliability: { paths, cwd, command: "test", operation: "throw-path" },
      });
    } catch (err) {
      caught = err as Error;
    }

    expect(caught?.message).toContain("session factory boom");
    const records = readRecords(cwd);
    expect(records).toHaveLength(1);
    expect(records[0]!.outcome).toBe("agent-error");
    expect(records[0]!.attempts).toBe(1);
    expect(records[0]!.reason).toContain("session factory boom");
  });

  test("no records emitted when reporter omitted (back-compat)", async () => {
    const cwd = mkTempCwd();
    const factory = makeFakeSessionFactory({
      responses: ['{"name":"Bea","age":22}'],
    });

    await runWithOutputValidation<Person>(factory as any, {
      cwd,
      prompt: "p",
      schema: "Person",
      parse: (raw) => parseStructuredOutput<Person>(raw, PersonSchema),
    });

    expect(readRecords(cwd)).toHaveLength(0);
  });
});