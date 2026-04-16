import { describe, expect, mock, test } from "bun:test";
import { getWorkingTreeStatus } from "../../src/git/status.js";

function mockExec(stdout: string, code = 0) {
  return mock().mockResolvedValue({ stdout, code });
}

describe("getWorkingTreeStatus", () => {
  test("returns dirty with staged and unstaged file lists when porcelain has entries", async () => {
    const exec = mockExec(" M src/index.ts\n?? newfile.ts\nA  staged.ts\n");
    const status = await getWorkingTreeStatus(exec, "/repo");

    expect(status.dirty).toBe(true);
    expect(status.files).toEqual(["src/index.ts", "newfile.ts", "staged.ts"]);
    expect(status.stagedFiles).toEqual(["staged.ts"]);
    expect(status.unstagedFiles).toEqual(["src/index.ts", "newfile.ts"]);
    expect(exec).toHaveBeenCalledWith("git", ["status", "--porcelain"], { cwd: "/repo" });
  });

  test("tracks files that are both staged and unstaged", async () => {
    const exec = mockExec("MM src/a.ts\nAM src/b.ts\n");
    const status = await getWorkingTreeStatus(exec, "/repo");

    expect(status.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(status.stagedFiles).toEqual(["src/a.ts", "src/b.ts"]);
    expect(status.unstagedFiles).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("prefers the renamed destination path", async () => {
    const exec = mockExec("R  src/old.ts -> src/new.ts\n");
    const status = await getWorkingTreeStatus(exec, "/repo");

    expect(status.files).toEqual(["src/new.ts"]);
    expect(status.stagedFiles).toEqual(["src/new.ts"]);
    expect(status.unstagedFiles).toEqual([]);
  });

  test("returns clean when porcelain is empty", async () => {
    const exec = mockExec("");
    const status = await getWorkingTreeStatus(exec, "/repo");

    expect(status.dirty).toBe(false);
    expect(status.files).toEqual([]);
    expect(status.stagedFiles).toEqual([]);
    expect(status.unstagedFiles).toEqual([]);
  });

  test("returns clean on non-zero exit (not a git repo)", async () => {
    const exec = mockExec("fatal: not a git repository", 128);
    const status = await getWorkingTreeStatus(exec, "/tmp/not-git");

    expect(status.dirty).toBe(false);
    expect(status.files).toEqual([]);
    expect(status.stagedFiles).toEqual([]);
    expect(status.unstagedFiles).toEqual([]);
  });

  test("returns clean when exec throws", async () => {
    const exec = mock().mockRejectedValue(new Error("spawn failed"));
    const status = await getWorkingTreeStatus(exec, "/repo");

    expect(status.dirty).toBe(false);
    expect(status.files).toEqual([]);
    expect(status.stagedFiles).toEqual([]);
    expect(status.unstagedFiles).toEqual([]);
  });
});
