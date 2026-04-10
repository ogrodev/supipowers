// tests/context-mode/event-extractor.test.ts
import { extractEvents, extractPromptEvents } from "../../src/context-mode/event-extractor.js";
import { PRIORITY } from "../../src/context-mode/event-store.js";

const SESSION_ID = "test-session";

function makeToolEvent(overrides: Record<string, unknown>) {
  return {
    type: "tool_result",
    toolCallId: "id",
    content: [{ type: "text", text: "" }],
    isError: false,
    details: undefined,
    ...overrides,
  } as any;
}

describe("extractEvents", () => {
  describe("general error rule", () => {
    test("emits error event for any tool with isError=true", () => {
      const event = makeToolEvent({
        toolName: "read",
        input: { path: "/test.ts" },
        content: [{ type: "text", text: "Permission denied" }],
        isError: true,
      });
      const events = extractEvents(event, SESSION_ID);
      expect(events.some((e) => e.category === "error")).toBe(true);
      const errEvent = events.find((e) => e.category === "error")!;
      expect(errEvent.priority).toBe(PRIORITY.critical);
      expect(errEvent.data).toContain("read");
    });
  });

  describe("bash extraction", () => {
    test("git command emits git event", () => {
      const event = makeToolEvent({
        toolName: "bash",
        input: { command: "git commit -m 'fix'" },
        content: [{ type: "text", text: "1 file changed" }],
        details: { exitCode: 0 },
      });
      const events = extractEvents(event, SESSION_ID);
      expect(events.some((e) => e.category === "git")).toBe(true);
    });

    test("non-zero exit emits error event", () => {
      const event = makeToolEvent({
        toolName: "bash",
        input: { command: "npm test" },
        content: [{ type: "text", text: "FAILED" }],
        details: { exitCode: 1 },
      });
      const events = extractEvents(event, SESSION_ID);
      expect(events.some((e) => e.category === "error")).toBe(true);
    });

    test("cd command emits cwd event", () => {
      const event = makeToolEvent({
        toolName: "bash",
        input: { command: "cd /project && ls" },
        content: [{ type: "text", text: "file1 file2" }],
        details: { exitCode: 0 },
      });
      const events = extractEvents(event, SESSION_ID);
      expect(events.some((e) => e.category === "cwd")).toBe(true);
    });
  });

  describe("read extraction", () => {
    test("emits file event with read op", () => {
      const event = makeToolEvent({
        toolName: "read",
        input: { path: "/src/index.ts" },
        content: [{ type: "text", text: "export default {}" }],
      });
      const events = extractEvents(event, SESSION_ID);
      expect(events).toHaveLength(1);
      expect(events[0].category).toBe("file");
      const data = JSON.parse(events[0].data);
      expect(data.op).toBe("read");
      expect(data.path).toBe("/src/index.ts");
    });
  });

  describe("edit extraction", () => {
    test("emits file event with edit op at high priority", () => {
      const event = makeToolEvent({
        toolName: "edit",
        input: { path: "/src/types.ts" },
        content: [{ type: "text", text: "edited" }],
        details: { path: "/src/types.ts" },
      });
      const events = extractEvents(event, SESSION_ID);
      expect(events[0].category).toBe("file");
      expect(events[0].priority).toBe(PRIORITY.high);
    });
  });

  describe("write extraction", () => {
    test("emits file event with write op from input", () => {
      const event = makeToolEvent({
        toolName: "write",
        input: { path: "/new-file.ts", content: "hello" },
        content: [{ type: "text", text: "written" }],
      });
      const events = extractEvents(event, SESSION_ID);
      expect(events[0].category).toBe("file");
      const data = JSON.parse(events[0].data);
      expect(data.op).toBe("write");
      expect(data.path).toBe("/new-file.ts");
    });
  });

  describe("grep extraction", () => {
    test("emits file event with search op", () => {
      const event = makeToolEvent({
        toolName: "grep",
        input: { pattern: "TODO", path: "src/" },
        content: [{ type: "text", text: "src/a.ts:1:TODO fix" }],
      });
      const events = extractEvents(event, SESSION_ID);
      expect(events[0].category).toBe("file");
      const data = JSON.parse(events[0].data);
      expect(data.op).toBe("search");
    });
  });

  describe("find extraction", () => {
    test("emits file event with find op", () => {
      const event = makeToolEvent({
        toolName: "find",
        input: { pattern: "*.ts" },
        content: [{ type: "text", text: "src/a.ts\nsrc/b.ts" }],
      });
      const events = extractEvents(event, SESSION_ID);
      expect(events[0].category).toBe("file");
      const data = JSON.parse(events[0].data);
      expect(data.op).toBe("find");
    });
  });

  describe("custom tool extraction", () => {
    test("todo_write emits task event", () => {
      const event = makeToolEvent({
        toolName: "todo_write",
        input: { ops: [{ op: "add_task", content: "Fix bug" }] },
        content: [{ type: "text", text: "ok" }],
      });
      const events = extractEvents(event, SESSION_ID);
      expect(events.some((e) => e.category === "task")).toBe(true);
    });

    test("ctx_* tools emit mcp event", () => {
      const event = makeToolEvent({
        toolName: "ctx_execute",
        input: { code: "ls" },
        content: [{ type: "text", text: "output" }],
      });
      const events = extractEvents(event, SESSION_ID);
      expect(events.some((e) => e.category === "mcp")).toBe(true);
    });

    test("sub-agent dispatch tools emit subagent event", () => {
      const event = makeToolEvent({
        toolName: "task",
        input: { assignment: "fix the bug" },
        content: [{ type: "text", text: "done" }],
      });
      const events = extractEvents(event, SESSION_ID);
      expect(events.some((e) => e.category === "subagent")).toBe(true);
    });

    test("unknown custom tools return empty array", () => {
      const event = makeToolEvent({
        toolName: "unknown_tool",
        input: {},
        content: [{ type: "text", text: "x" }],
      });
      const events = extractEvents(event, SESSION_ID);
      expect(events).toHaveLength(0);
    });
  });

  describe("rule extraction", () => {
    test("read of AGENTS.md emits both file and rule events", () => {
      const event = makeToolEvent({
        toolName: "read",
        input: { path: "/project/AGENTS.md" },
        content: [{ type: "text", text: "rules" }],
      });
      const events = extractEvents(event, SESSION_ID);
      expect(events.some((e) => e.category === "rule")).toBe(true);
      expect(events.some((e) => e.category === "file")).toBe(true);
      const rule = events.find((e) => e.category === "rule")!;
      expect(rule.priority).toBe(PRIORITY.critical);
      const data = JSON.parse(rule.data);
      expect(data.type).toBe("project-rule");
      expect(data.path).toBe("/project/AGENTS.md");
    });

    test("read of .omp/config.json emits both file and rule events", () => {
      const event = makeToolEvent({
        toolName: "read",
        input: { path: "/home/user/.omp/config.json" },
        content: [{ type: "text", text: "{}" }],
      });
      const events = extractEvents(event, SESSION_ID);
      expect(events.some((e) => e.category === "rule")).toBe(true);
      expect(events.some((e) => e.category === "file")).toBe(true);
    });

    test("read of normal file does NOT emit rule event", () => {
      const event = makeToolEvent({
        toolName: "read",
        input: { path: "/src/index.ts" },
        content: [{ type: "text", text: "code" }],
      });
      const events = extractEvents(event, SESSION_ID);
      expect(events.every((e) => e.category !== "rule")).toBe(true);
    });
  });

  describe("env extraction", () => {
    test("node --version emits env event", () => {
      const event = makeToolEvent({
        toolName: "bash",
        input: { command: "node --version" },
        content: [{ type: "text", text: "v20.0.0" }],
        details: { exitCode: 0 },
      });
      const events = extractEvents(event, SESSION_ID);
      expect(events.some((e) => e.category === "env")).toBe(true);
      const env = events.find((e) => e.category === "env")!;
      expect(env.priority).toBe(PRIORITY.medium);
    });

    test("bun --version emits env event", () => {
      const event = makeToolEvent({
        toolName: "bash",
        input: { command: "bun --version" },
        content: [{ type: "text", text: "1.0.0" }],
        details: { exitCode: 0 },
      });
      const events = extractEvents(event, SESSION_ID);
      expect(events.some((e) => e.category === "env")).toBe(true);
    });

    test("echo $PATH emits env event", () => {
      const event = makeToolEvent({
        toolName: "bash",
        input: { command: "echo $PATH" },
        content: [{ type: "text", text: "/usr/bin" }],
        details: { exitCode: 0 },
      });
      const events = extractEvents(event, SESSION_ID);
      expect(events.some((e) => e.category === "env")).toBe(true);
    });
  });

  describe("skill extraction", () => {
    test("read of skills/planning/SKILL.md emits both file and skill events", () => {
      const event = makeToolEvent({
        toolName: "read",
        input: { path: "/home/user/.omp/skills/planning/SKILL.md" },
        content: [{ type: "text", text: "skill content" }],
      });
      const events = extractEvents(event, SESSION_ID);
      expect(events.some((e) => e.category === "skill")).toBe(true);
      expect(events.some((e) => e.category === "file")).toBe(true);
      const skill = events.find((e) => e.category === "skill")!;
      expect(skill.priority).toBe(PRIORITY.medium);
      const data = JSON.parse(skill.data);
      expect(data.path).toBe("/home/user/.omp/skills/planning/SKILL.md");
    });

    test("read of normal file does NOT emit skill event", () => {
      const event = makeToolEvent({
        toolName: "read",
        input: { path: "/src/utils.ts" },
        content: [{ type: "text", text: "code" }],
      });
      const events = extractEvents(event, SESSION_ID);
      expect(events.every((e) => e.category !== "skill")).toBe(true);
    });
  });

  describe("data cap removed", () => {
    test("getTextContent no longer truncates at 500 chars", () => {
      const longText = "x".repeat(1000);
      const event = makeToolEvent({
        toolName: "bash",
        input: { command: "echo $HOME" },
        content: [{ type: "text", text: longText }],
        details: { exitCode: 0 },
      });
      const events = extractEvents(event, SESSION_ID);
      // echo $HOME matches env pattern, check the data contains full text
      const env = events.find((e) => e.category === "env")!;
      const data = JSON.parse(env.data);
      expect(data.output.length).toBe(1000);
    });
  });
});

describe("extractPromptEvents", () => {
  test("emits prompt event for any prompt", () => {
    const events = extractPromptEvents("show me the code", SESSION_ID);
    expect(events.some((e) => e.category === "prompt")).toBe(true);
  });

  test("emits decision event for directive language", () => {
    const events = extractPromptEvents("let's go with option A", SESSION_ID);
    expect(events.some((e) => e.category === "decision")).toBe(true);
  });

  test("does not emit decision for non-directive prompt", () => {
    const events = extractPromptEvents("what does this function do?", SESSION_ID);
    expect(events.every((e) => e.category !== "decision")).toBe(true);
  });

  describe("intent extraction", () => {
    test("prompt with 'fix the bug' emits intent event with intent: fix", () => {
      const events = extractPromptEvents("fix the bug", SESSION_ID);
      expect(events.some((e) => e.category === "intent")).toBe(true);
      const intent = events.find((e) => e.category === "intent")!;
      expect(intent.priority).toBe(PRIORITY.low);
      const data = JSON.parse(intent.data);
      expect(data.intent).toBe("fix");
    });

    test("prompt with 'build a dashboard' emits intent event with intent: build", () => {
      const events = extractPromptEvents("build a dashboard", SESSION_ID);
      const intent = events.find((e) => e.category === "intent")!;
      expect(intent).toBeDefined();
      const data = JSON.parse(intent.data);
      expect(data.intent).toBe("build");
    });
  });
});


describe("event extractor edge cases", () => {
  describe("getTextContent content merging", () => {
    test("multi-text content entries are joined with newline", () => {
      const event = makeToolEvent({
        toolName: "bash",
        input: { command: "node --version" },
        content: [
          { type: "text", text: "line1" },
          { type: "text", text: "line2" },
        ],
        details: { exitCode: 0 },
      });
      const events = extractEvents(event, SESSION_ID);
      const env = events.find((e) => e.category === "env")!;
      expect(env).toBeDefined();
      const data = JSON.parse(env.data);
      expect(data.output).toBe("line1\nline2");
    });

    test("non-text content entries are ignored", () => {
      const event = makeToolEvent({
        toolName: "bash",
        input: { command: "node --version" },
        content: [
          { type: "text", text: "real" },
          { type: "image", source: "blob" } as any,
        ],
        details: { exitCode: 0 },
      });
      const events = extractEvents(event, SESSION_ID);
      const env = events.find((e) => e.category === "env")!;
      const data = JSON.parse(env.data);
      expect(data.output).toBe("real");
    });

    test("empty content array does not crash and yields no text-derived fields", () => {
      const event = makeToolEvent({
        toolName: "read",
        input: { path: "/src/empty.ts" },
        content: [],
      });
      const events = extractEvents(event, SESSION_ID);
      // read still emits a file event even with empty content
      expect(events).toHaveLength(1);
      expect(events[0].category).toBe("file");
      const data = JSON.parse(events[0].data);
      expect(data.op).toBe("read");
      expect(data.path).toBe("/src/empty.ts");
    });
  });

  describe("isError and exit-code edge cases", () => {
    test("isError=true with empty content still emits error event", () => {
      const event = makeToolEvent({
        toolName: "read",
        input: { path: "/missing.ts" },
        content: [],
        isError: true,
      });
      const events = extractEvents(event, SESSION_ID);
      const err = events.find((e) => e.category === "error")!;
      expect(err).toBeDefined();
      expect(err.priority).toBe(PRIORITY.critical);
      const data = JSON.parse(err.data);
      expect(data.toolName).toBe("read");
      expect(data.content).toBe("");
    });

    test("non-zero exit with empty output still emits bash error event", () => {
      const event = makeToolEvent({
        toolName: "bash",
        input: { command: "false" },
        content: [],
        details: { exitCode: 1 },
      });
      const events = extractEvents(event, SESSION_ID);
      const err = events.find((e) => e.category === "error")!;
      expect(err).toBeDefined();
      const data = JSON.parse(err.data);
      expect(data.command).toBe("false");
      expect(data.exitCode).toBe(1);
      expect(data.output).toBe("");
    });
  });

  describe("bash multi-match edge cases", () => {
    test("'cd /repo && git commit' emits ONLY cwd (git pattern is ^-anchored)", () => {
      const event = makeToolEvent({
        toolName: "bash",
        input: { command: "cd /repo && git commit -m 'x'" },
        content: [{ type: "text", text: "" }],
        details: { exitCode: 0 },
      });
      const events = extractEvents(event, SESSION_ID);
      expect(events.some((e) => e.category === "cwd")).toBe(true);
      // git pattern is anchored at start of string, so 'cd ... && git ...' does NOT match
      expect(events.some((e) => e.category === "git")).toBe(false);
    });

    test("'git stash && cd /repo' emits BOTH git and cwd events", () => {
      const event = makeToolEvent({
        toolName: "bash",
        input: { command: "git stash && cd /repo" },
        content: [{ type: "text", text: "" }],
        details: { exitCode: 0 },
      });
      const events = extractEvents(event, SESSION_ID);
      expect(events.some((e) => e.category === "git")).toBe(true);
      expect(events.some((e) => e.category === "cwd")).toBe(true);
    });

    test("bash 'cat AGENTS.md' does NOT emit rule event (rule detection is read-only)", () => {
      const event = makeToolEvent({
        toolName: "bash",
        input: { command: "cat AGENTS.md" },
        content: [{ type: "text", text: "rules" }],
        details: { exitCode: 0 },
      });
      const events = extractEvents(event, SESSION_ID);
      expect(events.every((e) => e.category !== "rule")).toBe(true);
    });

    test("multiple env commands in one bash string emit exactly ONE env event", () => {
      const event = makeToolEvent({
        toolName: "bash",
        input: { command: "node --version; bun --version" },
        content: [{ type: "text", text: "v20.0.0\n1.0.0" }],
        details: { exitCode: 0 },
      });
      const events = extractEvents(event, SESSION_ID);
      const envEvents = events.filter((e) => e.category === "env");
      // extractBash emits one env event per call regardless of how many commands match
      expect(envEvents).toHaveLength(1);
    });
  });

  describe("rule/skill path edge cases", () => {
    test("rule path with trailing slash '/.omp/' matches rule pattern", () => {
      const event = makeToolEvent({
        toolName: "read",
        input: { path: "/.omp/" },
        content: [{ type: "text", text: "" }],
      });
      const events = extractEvents(event, SESSION_ID);
      expect(events.some((e) => e.category === "rule")).toBe(true);
    });

    test("read of 'CLAUDE.md' at root emits rule event", () => {
      const event = makeToolEvent({
        toolName: "read",
        input: { path: "CLAUDE.md" },
        content: [{ type: "text", text: "claude rules" }],
      });
      const events = extractEvents(event, SESSION_ID);
      const rule = events.find((e) => e.category === "rule")!;
      expect(rule).toBeDefined();
      const data = JSON.parse(rule.data);
      expect(data.path).toBe("CLAUDE.md");
      expect(data.type).toBe("project-rule");
    });

    test("path '.omp/skills/SKILL.md' emits BOTH rule and skill events", () => {
      const event = makeToolEvent({
        toolName: "read",
        input: { path: ".omp/skills/planning/SKILL.md" },
        content: [{ type: "text", text: "skill body" }],
      });
      const events = extractEvents(event, SESSION_ID);
      expect(events.some((e) => e.category === "rule")).toBe(true);
      expect(events.some((e) => e.category === "skill")).toBe(true);
      expect(events.some((e) => e.category === "file")).toBe(true);
    });
  });

  describe("subagent input capture", () => {
    test("task tool preserves full input on the subagent event", () => {
      const event = makeToolEvent({
        toolName: "task",
        input: {
          agent: "reviewer",
          tasks: [
            { id: "T1", description: "review", assignment: "do it" },
          ],
        },
        content: [{ type: "text", text: "done" }],
      });
      const events = extractEvents(event, SESSION_ID);
      const sub = events.find((e) => e.category === "subagent")!;
      expect(sub).toBeDefined();
      expect(sub.priority).toBe(PRIORITY.medium);
      const data = JSON.parse(sub.data);
      expect(data.toolName).toBe("task");
      expect(data.input.agent).toBe("reviewer");
      expect(Array.isArray(data.input.tasks)).toBe(true);
      expect(data.input.tasks[0].id).toBe("T1");
    });
  });
});

describe("extractPromptEvents edge cases", () => {
  test("empty prompt string still emits a prompt event", () => {
    const events = extractPromptEvents("", SESSION_ID);
    const prompt = events.find((e) => e.category === "prompt")!;
    expect(prompt).toBeDefined();
    const data = JSON.parse(prompt.data);
    expect(data.prompt).toBe("");
    // no decision, no intent
    expect(events.every((e) => e.category !== "decision")).toBe(true);
    expect(events.every((e) => e.category !== "intent")).toBe(true);
  });

  test("prompt with decision pattern + intent verb emits prompt, decision, and intent", () => {
    const events = extractPromptEvents("let's go with plan B, let's build it", SESSION_ID);
    expect(events.some((e) => e.category === "prompt")).toBe(true);
    expect(events.some((e) => e.category === "decision")).toBe(true);
    const intent = events.find((e) => e.category === "intent")!;
    expect(intent).toBeDefined();
    const data = JSON.parse(intent.data);
    // regex .match() returns the FIRST match in the string; 'plan' precedes 'build'
    expect(data.intent).toBe("plan");
  });

  test("prompt with multiple intent verbs — first match wins", () => {
    const events = extractPromptEvents("fix the bug and add tests", SESSION_ID);
    const intents = events.filter((e) => e.category === "intent");
    expect(intents).toHaveLength(1);
    const data = JSON.parse(intents[0].data);
    expect(data.intent).toBe("fix");
  });

  test("prompt with no intent markers emits no intent event", () => {
    const events = extractPromptEvents("hello world", SESSION_ID);
    expect(events.some((e) => e.category === "prompt")).toBe(true);
    expect(events.every((e) => e.category !== "intent")).toBe(true);
    expect(events.every((e) => e.category !== "decision")).toBe(true);
  });

  test("past-tense verb 'fixed' does NOT match intent pattern (word-boundary)", () => {
    // The pattern is \b(build|fix|...)\b — 'fixed' contains no word boundary inside,
    // so \bfix\b cannot match 'fixed'.
    const events = extractPromptEvents("I already fixed it", SESSION_ID);
    expect(events.every((e) => e.category !== "intent")).toBe(true);
  });
});
