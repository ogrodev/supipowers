import { describe, expect, mock, test } from "bun:test";
import { detectBaseBranch } from "../../src/git/base-branch.js";

describe("detectBaseBranch", () => {
  test("returns branch from symbolic-ref when available", async () => {
    const exec = mock().mockResolvedValue({
      stdout: "refs/remotes/origin/develop\n",
      code: 0,
    });
    const branch = await detectBaseBranch(exec);
    expect(branch).toBe("develop");
    expect(exec).toHaveBeenCalledWith("git", ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  });

  test("falls back to init.defaultBranch when symbolic-ref fails", async () => {
    const exec = mock()
      .mockResolvedValueOnce({ stdout: "", code: 1 })
      .mockResolvedValueOnce({ stdout: "trunk\n", code: 0 });
    const branch = await detectBaseBranch(exec);
    expect(branch).toBe("trunk");
  });

  test("falls back to 'main' when both strategies fail", async () => {
    const exec = mock()
      .mockResolvedValueOnce({ stdout: "", code: 1 })
      .mockResolvedValueOnce({ stdout: "", code: 1 });
    const branch = await detectBaseBranch(exec);
    expect(branch).toBe("main");
  });

  test("falls back to 'main' when exec throws", async () => {
    const exec = mock().mockRejectedValue(new Error("command not found"));
    const branch = await detectBaseBranch(exec);
    expect(branch).toBe("main");
  });

  test("ignores symbolic-ref output that doesn't match expected prefix", async () => {
    const exec = mock()
      .mockResolvedValueOnce({ stdout: "some/weird/ref\n", code: 0 })
      .mockResolvedValueOnce({ stdout: "master\n", code: 0 });
    const branch = await detectBaseBranch(exec);
    expect(branch).toBe("master");
  });
});
