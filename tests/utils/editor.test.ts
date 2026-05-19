import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ExecOptions, ExecResult, Platform } from "../../src/platform/types.js";
import { openInEditor, resolveDefaultEditorInvocation } from "../../src/utils/editor.js";

interface RecordedCall {
  cmd: string;
  args: string[];
  opts?: ExecOptions;
}

function makePlatformRecorder(): { calls: RecordedCall[]; platform: Platform } {
  const calls: RecordedCall[] = [];
  const platform = {
    exec: async (cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult> => {
      calls.push({ cmd, args, opts });
      return { stdout: "", stderr: "", code: 0 };
    },
  } as Platform;
  return { calls, platform };
}

let originalVisual: string | undefined;
let originalEditor: string | undefined;

beforeEach(() => {
  originalVisual = process.env.VISUAL;
  originalEditor = process.env.EDITOR;
  delete process.env.VISUAL;
  delete process.env.EDITOR;
});

afterEach(() => {
  if (originalVisual === undefined) delete process.env.VISUAL;
  else process.env.VISUAL = originalVisual;
  if (originalEditor === undefined) delete process.env.EDITOR;
  else process.env.EDITOR = originalEditor;
});

describe("resolveDefaultEditorInvocation", () => {
  test("wraps Windows start through a single quoted cmd payload", () => {
    expect(resolveDefaultEditorInvocation("win32", "C:\\tmp\\a & b (1).md")).toEqual({
      command: "cmd",
      args: ["/d", "/s", "/c", 'start "" "C:\\tmp\\a & b (1).md"'],
    });
  });

  test("keeps macOS and Linux default openers direct", () => {
    expect(resolveDefaultEditorInvocation("darwin", "/tmp/file.md")).toEqual({
      command: "open",
      args: ["/tmp/file.md"],
    });
    expect(resolveDefaultEditorInvocation("linux", "/tmp/file.md")).toEqual({
      command: "xdg-open",
      args: ["/tmp/file.md"],
    });
  });
});

describe("openInEditor", () => {
  test("uses Windows cmd wrapper for default opener", async () => {
    const { calls, platform } = makePlatformRecorder();

    await openInEditor(platform, "C:\\tmp\\file.md", "win32");

    expect(calls).toEqual([
      { cmd: "cmd", args: ["/d", "/s", "/c", 'start "" "C:\\tmp\\file.md"'] },
    ]);
  });

  test("honors VISUAL before default opener", async () => {
    const { calls, platform } = makePlatformRecorder();
    process.env.VISUAL = "code --wait";

    await openInEditor(platform, "/tmp/file.md", "win32");

    expect(calls).toEqual([
      { cmd: "code", args: ["--wait", "/tmp/file.md"] },
    ]);
  });
});
