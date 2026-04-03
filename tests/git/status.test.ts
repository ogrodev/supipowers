import { describe, expect, mock, test } from "bun:test";
import { getWorkingTreeStatus } from "../../src/git/status.js";

function mockExec(stdout: string, code = 0) {
  return mock().mockResolvedValue({ stdout, code });
}

describe("getWorkingTreeStatus", () => {
  test("returns dirty with file list when porcelain has entries", async () => {
    const exec = mockExec(" M src/index.ts\n?? newfile.ts\nA  staged.ts\n");
    const status = await getWorkingTreeStatus(exec, "/repo");

    expect(status.dirty).toBe(true);
    expect(status.files).toEqual(["src/index.ts", "newfile.ts", "staged.ts"]);
    expect(exec).toHaveBeenCalledWith("git", ["status", "--porcelain"], { cwd: "/repo" });
  });

  test("returns clean when porcelain is empty", async () => {
    const exec = mockExec("");
    const status = await getWorkingTreeStatus(exec, "/repo");

    expect(status.dirty).toBe(false);
    expect(status.files).toEqual([]);
  });

  test("returns clean on non-zero exit (not a git repo)", async () => {
    const exec = mockExec("fatal: not a git repository", 128);
    const status = await getWorkingTreeStatus(exec, "/tmp/not-git");

    expect(status.dirty).toBe(false);
    expect(status.files).toEqual([]);
  });

  test("returns clean when exec throws", async () => {
    const exec = mock().mockRejectedValue(new Error("spawn failed"));
    const status = await getWorkingTreeStatus(exec, "/repo");

    expect(status.dirty).toBe(false);
    expect(status.files).toEqual([]);
  });

  test("strips 3-char status prefix correctly", async () => {
    // Porcelain format: XY<space>filename — 3 chars to strip
    const exec = mockExec("MM src/a.ts\nAM src/b.ts\n");
    const status = await getWorkingTreeStatus(exec, "/repo");

    expect(status.files).toEqual(["src/a.ts", "src/b.ts"]);
  });
});
