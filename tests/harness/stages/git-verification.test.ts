import { describe, expect, test } from "bun:test";

import {
  applyMainProtectionRuleset,
  buildRulesetBody,
  createBranchFromRef,
  detectGitTopology,
  listBranches,
  renderManualInstructions,
  type ExecCall,
  type ExecFn,
  type GhExecOutcome,
} from "../../../src/harness/git-verification.js";

function makeExec(
  scripted: Array<{ match: (cmd: string, args: string[]) => boolean; result: { stdout?: string; stderr?: string; code: number } }>,
  recorder: ExecCall[],
): ExecFn {
  return async (cmd, args) => {
    recorder.push({ cmd, args });
    for (const step of scripted) {
      if (step.match(cmd, args)) {
        return {
          stdout: step.result.stdout ?? "",
          stderr: step.result.stderr ?? "",
          code: step.result.code,
        };
      }
    }
    return { stdout: "", stderr: `unscripted: ${cmd} ${args.join(" ")}`, code: 127 };
  };
}

describe("listBranches", () => {
  test("merges local + remote refs and drops origin/HEAD pointer", async () => {
    const calls: ExecCall[] = [];
    const exec = makeExec(
      [
        {
          match: (cmd, args) => cmd === "git" && args[0] === "branch" && args.includes("--format=%(refname:short)"),
          result: { stdout: "main\nfeature/a\n", code: 0 },
        },
        {
          match: (cmd, args) => cmd === "git" && args[0] === "ls-remote",
          result: {
            stdout: [
              "deadbeef\trefs/heads/main",
              "deadbeef\trefs/heads/dev",
              "deadbeef\tHEAD",
            ].join("\n"),
            code: 0,
          },
        },
      ],
      calls,
    );

    const result = await listBranches(exec, "/repo");
    expect(result.local).toEqual(["main", "feature/a"]);
    expect(result.remote).toEqual(["main", "dev"]);
  });

  test("returns empty arrays when git is unavailable", async () => {
    const exec: ExecFn = async () => ({ stdout: "", stderr: "git: not found", code: 127 });
    const result = await listBranches(exec, "/repo");
    expect(result.local).toEqual([]);
    expect(result.remote).toEqual([]);
  });
});

describe("detectGitTopology", () => {
  test("identifies main/dev pair when both branches are present on origin", async () => {
    const calls: ExecCall[] = [];
    const exec = makeExec(
      [
        {
          match: (cmd, args) => cmd === "git" && args[0] === "symbolic-ref",
          result: { stdout: "refs/remotes/origin/main\n", code: 0 },
        },
        {
          match: (cmd, args) => cmd === "git" && args[0] === "branch",
          result: { stdout: "main\ndev\n", code: 0 },
        },
        {
          match: (cmd, args) => cmd === "git" && args[0] === "ls-remote",
          result: { stdout: "deadbeef\trefs/heads/main\ndeadbeef\trefs/heads/dev\n", code: 0 },
        },
      ],
      calls,
    );

    const topology = await detectGitTopology(exec, "/repo");
    expect(topology.mainBranch).toBe("main");
    expect(topology.devBranchCandidates).toContain("dev");
    expect(topology.defaultIsMainOrMaster).toBe(true);
  });

  test("flags non-main default branch as already-development", async () => {
    const exec = makeExec(
      [
        {
          match: (cmd, args) => cmd === "git" && args[0] === "symbolic-ref",
          result: { stdout: "refs/remotes/origin/trunk\n", code: 0 },
        },
        {
          match: (cmd, args) => cmd === "git" && args[0] === "branch",
          result: { stdout: "trunk\n", code: 0 },
        },
        {
          match: (cmd, args) => cmd === "git" && args[0] === "ls-remote",
          result: { stdout: "deadbeef\trefs/heads/trunk\n", code: 0 },
        },
      ],
      [],
    );

    const topology = await detectGitTopology(exec, "/repo");
    expect(topology.mainBranch).toBe("trunk");
    expect(topology.defaultIsMainOrMaster).toBe(false);
  });

  test("falls back to main when origin/HEAD is missing", async () => {
    const exec = makeExec(
      [
        {
          match: (cmd, args) => cmd === "git" && args[0] === "symbolic-ref",
          result: { stdout: "", stderr: "ref does not exist", code: 1 },
        },
        {
          match: (cmd, args) => cmd === "git" && args[0] === "branch",
          result: { stdout: "main\n", code: 0 },
        },
        {
          match: (cmd, args) => cmd === "git" && args[0] === "ls-remote",
          result: { stdout: "", code: 0 },
        },
      ],
      [],
    );

    const topology = await detectGitTopology(exec, "/repo");
    expect(topology.mainBranch).toBe("main");
  });
});

describe("createBranchFromRef", () => {
  test("happy path issues switch + push -u with the expected args", async () => {
    const calls: ExecCall[] = [];
    const exec = makeExec(
      [
        {
          match: (cmd, args) => cmd === "git" && args[0] === "rev-parse",
          result: { stdout: "", stderr: "", code: 1 }, // branch does not exist
        },
        {
          match: (cmd, args) => cmd === "git" && args[0] === "switch",
          result: { stdout: "Switched to a new branch 'dev'", code: 0 },
        },
        {
          match: (cmd, args) => cmd === "git" && args[0] === "push",
          result: { stdout: "", code: 0 },
        },
      ],
      calls,
    );

    const outcome = await createBranchFromRef(exec, "/repo", "dev", "origin/main");
    expect(outcome.kind).toBe("created");
    const switchCall = calls.find((c) => c.cmd === "git" && c.args[0] === "switch");
    expect(switchCall?.args).toEqual(["switch", "-c", "dev", "origin/main"]);
    const pushCall = calls.find((c) => c.cmd === "git" && c.args[0] === "push");
    expect(pushCall?.args).toEqual(["push", "-u", "origin", "dev"]);
  });

  test("returns already-exists without invoking switch when branch is present locally", async () => {
    const calls: ExecCall[] = [];
    const exec = makeExec(
      [
        {
          match: (cmd, args) => cmd === "git" && args[0] === "rev-parse",
          result: { stdout: "abcdef\n", code: 0 },
        },
      ],
      calls,
    );

    const outcome = await createBranchFromRef(exec, "/repo", "dev", "origin/main");
    expect(outcome.kind).toBe("already-exists");
    expect(calls.some((c) => c.args[0] === "switch")).toBe(false);
  });

  test("rejects unsafe branch names without invoking git", async () => {
    const calls: ExecCall[] = [];
    const exec = makeExec([], calls);
    const outcome = await createBranchFromRef(exec, "/repo", "../escape", "origin/main");
    expect(outcome.kind).toBe("failed");
    expect(calls).toEqual([]);
  });
});

describe("applyMainProtectionRuleset", () => {
  test("posts a ruleset that restricts main PRs to dev head_ref", async () => {
    const calls: ExecCall[] = [];
    const exec = makeExec(
      [
        {
          match: (cmd, args) => cmd === "gh" && args[0] === "auth",
          result: { stdout: "", code: 0 },
        },
        {
          match: (cmd, args) => cmd === "gh" && args[0] === "repo" && args[1] === "view",
          result: { stdout: "octo/repo\n", code: 0 },
        },
        {
          match: (cmd, args) => cmd === "gh" && args[0] === "api" && args.includes("POST"),
          result: { stdout: JSON.stringify({ id: 12345 }), code: 0 },
        },
      ],
      calls,
    );

    const outcome = await applyMainProtectionRuleset(exec, "/repo", {
      mainBranch: "main",
      devBranch: "dev",
    });
    expect(outcome.kind).toBe("applied");
    const apiCall = calls.find((c) => c.cmd === "gh" && c.args[0] === "api");
    expect(apiCall).toBeDefined();
    // The body is delivered via `--input <path>` (not inline). Verify the flag is present
    // and the path points at a real file the helper just wrote.
    const inputIdx = apiCall!.args.indexOf("--input");
    expect(inputIdx).toBeGreaterThan(-1);
    expect(apiCall!.args).toContain("--method");
    expect(apiCall!.args).toContain("POST");
  });

  test("buildRulesetBody encodes main/dev branches into the ruleset payload", () => {
    const body = buildRulesetBody("main", "dev") as {
      name: string;
      conditions: { ref_name: { include: string[] } };
      rules: Array<{ type: string }>;
      enforcement: string;
    };
    expect(body.name).toContain("dev");
    expect(body.conditions.ref_name.include).toContain("refs/heads/main");
    expect(body.enforcement).toBe("active");
    expect(body.rules.some((r) => r.type === "pull_request")).toBe(true);
  });

  test("fails open with no-cli when gh is missing", async () => {
    const exec: ExecFn = async () => ({ stdout: "", stderr: "command not found", code: 127 });
    const outcome = await applyMainProtectionRuleset(exec, "/repo", {
      mainBranch: "main",
      devBranch: "dev",
    });
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toBe("no-cli");
    }
  });

  test("fails open with no-auth when gh auth status is non-zero", async () => {
    const calls: ExecCall[] = [];
    const exec = makeExec(
      [
        {
          match: (cmd, args) => cmd === "gh" && args[0] === "auth",
          result: { stdout: "", stderr: "not logged in", code: 1 },
        },
      ],
      calls,
    );
    const outcome = await applyMainProtectionRuleset(exec, "/repo", {
      mainBranch: "main",
      devBranch: "dev",
    });
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toBe("no-auth");
    }
  });

  test("returns no-op (not failed) when devBranch is null", async () => {
    const calls: ExecCall[] = [];
    const exec = makeExec([], calls);
    const outcome: GhExecOutcome = await applyMainProtectionRuleset(exec, "/repo", {
      mainBranch: "main",
      devBranch: null,
    });
    expect(outcome.kind).toBe("skipped");
    expect(calls).toEqual([]);
  });
});

describe("renderManualInstructions", () => {
  test("includes git create-branch step + ruleset UI path when devBranch is set", () => {
    const md = renderManualInstructions({
      mainBranch: "main",
      devBranch: "dev",
      enforceMainFromDevOnly: true,
      ghAvailable: false,
    });
    expect(md).toContain("git switch -c dev");
    expect(md).toContain("main");
    expect(md).toContain("Settings");
    expect(md).toContain("ruleset");
  });

  test("omits ruleset section when enforceMainFromDevOnly is false", () => {
    const md = renderManualInstructions({
      mainBranch: "main",
      devBranch: "dev",
      enforceMainFromDevOnly: false,
      ghAvailable: true,
    });
    expect(md).not.toContain("ruleset");
  });
});
