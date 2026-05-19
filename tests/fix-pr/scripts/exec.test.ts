import { describe, expect, test } from "bun:test";

import { buildCliInvocation } from "../../../src/fix-pr/scripts/exec.js";

describe("buildCliInvocation", () => {
  test("wraps Windows cmd shims through cmd.exe", () => {
    const invocation = buildCliInvocation(
      "C:\\Program Files\\GitHub CLI\\gh.cmd",
      ["api", "repos/acme/example/issues/1/comments", "-f", "body=hello \"agent\""],
      "win32",
    );

    expect(invocation.cmd).toBe("cmd.exe");
    expect(invocation.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(invocation.args[3]?.startsWith('""C:\\Program Files\\GitHub CLI\\gh.cmd"')).toBe(true);
    expect(invocation.args[3]).toContain('"C:\\Program Files\\GitHub CLI\\gh.cmd"');
    expect(invocation.args[3]).toContain('"body=hello ""agent"""');
  });

  test("passes through Windows executables", () => {
    expect(buildCliInvocation("C:\\Tools\\gh.exe", ["--version"], "win32")).toEqual({
      cmd: "C:\\Tools\\gh.exe",
      args: ["--version"],
    });
  });

  test("passes through POSIX commands", () => {
    expect(buildCliInvocation("/usr/local/bin/gh.cmd", ["--version"], "linux")).toEqual({
      cmd: "/usr/local/bin/gh.cmd",
      args: ["--version"],
    });
  });
});
