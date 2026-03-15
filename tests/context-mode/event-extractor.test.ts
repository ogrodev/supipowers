// tests/context-mode/event-extractor.test.ts
import { extractEvents, extractPromptEvents } from "../../src/context-mode/event-extractor.js";

const SESSION_ID = "test-session";

describe("extractEvents", () => {
  describe("general error rule", () => {
    test("emits error event for any tool with isError=true", () => {
      const event = {
        type: "tool_result",
        toolName: "read",
        toolCallId: "id",
        input: { path: "/test.ts" },
        content: [{ type: "text", text: "Permission denied" }],
        isError: true,
        details: undefined,
      } as any;
      const events = extractEvents(event, SESSION_ID);
      expect(events.some((e) => e.category === "error")).toBe(true);
      const errEvent = events.find((e) => e.category === "error")!;
      expect(errEvent.priority).toBe("critical");
      expect(errEvent.data).toContain("read");
    });
  });

  describe("bash extraction", () => {
    test("git command emits git event", () => {
      const event = {
        type: "tool_result", toolName: "bash", toolCallId: "id",
        input: { command: "git commit -m 'fix'" },
        content: [{ type: "text", text: "1 file changed" }],
        isError: false,
        details: { exitCode: 0 },
      } as any;
      const events = extractEvents(event, SESSION_ID);
      expect(events.some((e) => e.category === "git")).toBe(true);
    });

    test("non-zero exit emits error event", () => {
      const event = {
        type: "tool_result", toolName: "bash", toolCallId: "id",
        input: { command: "npm test" },
        content: [{ type: "text", text: "FAILED" }],
        isError: false,
        details: { exitCode: 1 },
      } as any;
      const events = extractEvents(event, SESSION_ID);
      expect(events.some((e) => e.category === "error")).toBe(true);
    });

    test("cd command emits cwd event", () => {
      const event = {
        type: "tool_result", toolName: "bash", toolCallId: "id",
        input: { command: "cd /project && ls" },
        content: [{ type: "text", text: "file1 file2" }],
        isError: false,
        details: { exitCode: 0 },
      } as any;
      const events = extractEvents(event, SESSION_ID);
      expect(events.some((e) => e.category === "cwd")).toBe(true);
    });
  });

  describe("read extraction", () => {
    test("emits file event with read op", () => {
      const event = {
        type: "tool_result", toolName: "read", toolCallId: "id",
        input: { path: "/src/index.ts" },
        content: [{ type: "text", text: "export default {}" }],
        isError: false, details: undefined,
      } as any;
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
      const event = {
        type: "tool_result", toolName: "edit", toolCallId: "id",
        input: { path: "/src/types.ts" },
        content: [{ type: "text", text: "edited" }],
        isError: false, details: { path: "/src/types.ts" },
      } as any;
      const events = extractEvents(event, SESSION_ID);
      expect(events[0].category).toBe("file");
      expect(events[0].priority).toBe("high");
    });
  });

  describe("write extraction", () => {
    test("emits file event with write op from input", () => {
      const event = {
        type: "tool_result", toolName: "write", toolCallId: "id",
        input: { path: "/new-file.ts", content: "hello" },
        content: [{ type: "text", text: "written" }],
        isError: false, details: undefined,
      } as any;
      const events = extractEvents(event, SESSION_ID);
      expect(events[0].category).toBe("file");
      const data = JSON.parse(events[0].data);
      expect(data.op).toBe("write");
      expect(data.path).toBe("/new-file.ts");
    });
  });

  describe("grep extraction", () => {
    test("emits file event with search op", () => {
      const event = {
        type: "tool_result", toolName: "grep", toolCallId: "id",
        input: { pattern: "TODO", path: "src/" },
        content: [{ type: "text", text: "src/a.ts:1:TODO fix" }],
        isError: false, details: undefined,
      } as any;
      const events = extractEvents(event, SESSION_ID);
      expect(events[0].category).toBe("file");
      const data = JSON.parse(events[0].data);
      expect(data.op).toBe("search");
    });
  });

  describe("find extraction", () => {
    test("emits file event with find op", () => {
      const event = {
        type: "tool_result", toolName: "find", toolCallId: "id",
        input: { pattern: "*.ts" },
        content: [{ type: "text", text: "src/a.ts\nsrc/b.ts" }],
        isError: false, details: undefined,
      } as any;
      const events = extractEvents(event, SESSION_ID);
      expect(events[0].category).toBe("file");
      const data = JSON.parse(events[0].data);
      expect(data.op).toBe("find");
    });
  });

  describe("custom tool extraction", () => {
    test("todo_write emits task event", () => {
      const event = {
        type: "tool_result", toolName: "todo_write", toolCallId: "id",
        input: { ops: [{ op: "add_task", content: "Fix bug" }] },
        content: [{ type: "text", text: "ok" }],
        isError: false, details: undefined,
      } as any;
      const events = extractEvents(event, SESSION_ID);
      expect(events.some((e) => e.category === "task")).toBe(true);
    });

    test("ctx_* tools emit mcp event", () => {
      const event = {
        type: "tool_result", toolName: "ctx_execute", toolCallId: "id",
        input: { code: "ls" },
        content: [{ type: "text", text: "output" }],
        isError: false, details: undefined,
      } as any;
      const events = extractEvents(event, SESSION_ID);
      expect(events.some((e) => e.category === "mcp")).toBe(true);
    });

    test("sub-agent dispatch tools emit subagent event", () => {
      const event = {
        type: "tool_result", toolName: "task", toolCallId: "id",
        input: { assignment: "fix the bug" },
        content: [{ type: "text", text: "done" }],
        isError: false, details: undefined,
      } as any;
      const events = extractEvents(event, SESSION_ID);
      expect(events.some((e) => e.category === "subagent")).toBe(true);
    });

    test("unknown custom tools return empty array", () => {
      const event = {
        type: "tool_result", toolName: "unknown_tool", toolCallId: "id",
        input: {},
        content: [{ type: "text", text: "x" }],
        isError: false, details: undefined,
      } as any;
      const events = extractEvents(event, SESSION_ID);
      expect(events).toHaveLength(0);
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
});
