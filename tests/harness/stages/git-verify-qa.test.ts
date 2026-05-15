import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runGitVerificationQa } from "../../../src/harness/git-verify-qa.js";
import type { ExecCall, ExecFn } from "../../../src/harness/git-verification.js";
import type { HarnessCiGitConfig } from "../../../src/types.js";

let tmpDir: string;
let cwd: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-harness-qa-"));
  cwd = path.join(tmpDir, "repo");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(cwd, ".git"), { recursive: true }); // make cwd look like a repo
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

interface ScriptedExecStep {
  match: (cmd: string, args: string[]) => boolean;
  result: { stdout?: string; stderr?: string; code: number };
}

function makeExec(scripted: ScriptedExecStep[], recorder: ExecCall[]): ExecFn {
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

interface ScriptedUi {
  selectAnswers: string[];
  inputAnswers: string[];
  notifications: string[];
  selectPrompts: string[];
  inputPrompts: string[];
}

function makeUi(answers: { selects?: string[]; inputs?: string[] } = {}): ScriptedUi & {
  select: (title: string, options: string[]) => Promise<string | null>;
  input: (label: string) => Promise<string | null>;
  notify: (message: string, level?: "info" | "warning" | "error") => void;
} {
  const state: ScriptedUi = {
    selectAnswers: [...(answers.selects ?? [])],
    inputAnswers: [...(answers.inputs ?? [])],
    notifications: [],
    selectPrompts: [],
    inputPrompts: [],
  };
  return {
    ...state,
    async select(title, _options) {
      state.selectPrompts.push(title);
      const next = state.selectAnswers.shift();
      return next ?? null;
    },
    async input(label) {
      state.inputPrompts.push(label);
      const next = state.inputAnswers.shift();
      return next ?? null;
    },
    notify(message) {
      state.notifications.push(message);
    },
  };
}

const TOPOLOGY_SCRIPT_MAIN_NO_DEV: ScriptedExecStep[] = [
  {
    match: (cmd, args) => cmd === "git" && args[0] === "symbolic-ref",
    result: { stdout: "refs/remotes/origin/main\n", code: 0 },
  },
  {
    match: (cmd, args) => cmd === "git" && args[0] === "branch",
    result: { stdout: "main\n", code: 0 },
  },
  {
    match: (cmd, args) => cmd === "git" && args[0] === "ls-remote",
    result: { stdout: "deadbeef\trefs/heads/main\n", code: 0 },
  },
];

describe("runGitVerificationQa — opt-out paths", () => {
  test("returns null when user declines to run verification", async () => {
    const ui = makeUi({ selects: ["Skip"] });
    const exec = makeExec(TOPOLOGY_SCRIPT_MAIN_NO_DEV, []);
    const sessionDir = path.join(tmpDir, "session");
    fs.mkdirSync(sessionDir, { recursive: true });

    const result = await runGitVerificationQa({
      exec,
      cwd,
      ui,
      sessionDir,
      now: () => "2026-05-14T00:00:00.000Z",
    });

    expect(result).toBeNull();
    expect(ui.selectPrompts[0]).toContain("Git");
  });
});

describe("runGitVerificationQa — main with no dev branch, user creates one", () => {
  test("creates dev from main and records the topology", async () => {
    const calls: ExecCall[] = [];
    const exec = makeExec(
      [
        ...TOPOLOGY_SCRIPT_MAIN_NO_DEV,
        // probe — branch doesn't exist
        {
          match: (cmd, args) => cmd === "git" && args[0] === "rev-parse",
          result: { stdout: "", stderr: "", code: 1 },
        },
        {
          match: (cmd, args) => cmd === "git" && args[0] === "switch",
          result: { stdout: "", code: 0 },
        },
        {
          match: (cmd, args) => cmd === "git" && args[0] === "push",
          result: { stdout: "", code: 0 },
        },
        // gh auth, repo view, ruleset POST
        {
          match: (cmd, args) => cmd === "gh" && args[0] === "auth",
          result: { stdout: "", code: 0 },
        },
        {
          match: (cmd, args) => cmd === "gh" && args[0] === "repo" && args[1] === "view",
          result: { stdout: "octo/repo\n", code: 0 },
        },
        {
          match: (cmd, args) => cmd === "gh" && args[0] === "api",
          result: { stdout: JSON.stringify({ id: 999 }), code: 0 },
        },
      ],
      [],
    );

    const ui = makeUi({
      selects: [
        "Run verification",            // top-level
        "No, I don't have one",        // have dev branch?
        "Yes — create one",            // want one?
        "Create new branch from main", // create vs promote
      ],
      inputs: ["dev"],                 // branch name
    });

    const sessionDir = path.join(tmpDir, "session");
    fs.mkdirSync(sessionDir, { recursive: true });

    const result = (await runGitVerificationQa({
      exec,
      cwd,
      ui,
      sessionDir,
      now: () => "2026-05-14T00:00:00.000Z",
    })) as HarnessCiGitConfig;

    expect(result).not.toBeNull();
    expect(result.mainBranch).toBe("main");
    expect(result.devBranch).toBe("dev");
    expect(result.enforceMainFromDevOnly).toBe(true);
    expect(result.verification).not.toBeNull();
    expect(result.verification!.appliedProtections).toContain("branch-created");
    expect(result.verification!.appliedProtections).toContain("ruleset");
  });
});

describe("runGitVerificationQa — main with dev candidate, user accepts", () => {
  test("accepts existing dev candidate without creating a branch", async () => {
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
        // No switch/push expected since we accept existing dev.
        {
          match: (cmd, args) => cmd === "gh" && args[0] === "auth",
          result: { stdout: "", stderr: "not logged in", code: 1 },
        },
      ],
      calls,
    );

    const ui = makeUi({
      selects: [
        "Run verification",
        "Yes — use dev",   // existing dev candidate
      ],
    });

    const sessionDir = path.join(tmpDir, "session");
    fs.mkdirSync(sessionDir, { recursive: true });

    const result = (await runGitVerificationQa({
      exec,
      cwd,
      ui,
      sessionDir,
      now: () => "2026-05-14T00:00:00.000Z",
    })) as HarnessCiGitConfig;

    expect(result.devBranch).toBe("dev");
    expect(result.verification!.appliedProtections).not.toContain("branch-created");
    // gh auth failed → manual instructions doc should exist.
    expect(result.verification!.manualInstructionsPath).not.toBeNull();
    const docAbs = path.join(sessionDir, result.verification!.manualInstructionsPath!);
    expect(fs.existsSync(docAbs)).toBe(true);
    const findings = result.verification!.findings;
    expect(findings.some((f) => f.message.includes("gh"))).toBe(true);
  });
});

describe("runGitVerificationQa — default branch is already a dev branch", () => {
  test("records the dev branch and treats main as main", async () => {
    const exec = makeExec(
      [
        {
          match: (cmd, args) => cmd === "git" && args[0] === "symbolic-ref",
          result: { stdout: "refs/remotes/origin/develop\n", code: 0 },
        },
        {
          match: (cmd, args) => cmd === "git" && args[0] === "branch",
          result: { stdout: "develop\nmain\n", code: 0 },
        },
        {
          match: (cmd, args) => cmd === "git" && args[0] === "ls-remote",
          result: { stdout: "deadbeef\trefs/heads/develop\ndeadbeef\trefs/heads/main\n", code: 0 },
        },
        {
          match: (cmd, args) => cmd === "gh" && args[0] === "auth",
          result: { stdout: "", stderr: "not logged in", code: 1 },
        },
      ],
      [],
    );

    const ui = makeUi({
      selects: [
        "Run verification",
        "develop", // pick develop as dev branch (when default is already dev)
      ],
    });

    const sessionDir = path.join(tmpDir, "session");
    fs.mkdirSync(sessionDir, { recursive: true });

    const result = (await runGitVerificationQa({
      exec,
      cwd,
      ui,
      sessionDir,
      now: () => "2026-05-14T00:00:00.000Z",
    })) as HarnessCiGitConfig;

    expect(result.devBranch).toBe("develop");
    expect(result.mainBranch).toBe("main");
  });
});

describe("runGitVerificationQa — capture-side branch-name validation", () => {
  // Branch names captured here are interpolated into the rendered GitHub Actions
  // workflow's YAML expression and shell guard at implement time. Anything that lands
  // in the spec must already be safe — otherwise a malicious or careless branch name
  // breaks the workflow or executes attacker-controlled commands inside the runner.
  test("rejects an unsafe user-supplied dev branch name and records a warning finding", async () => {
    const exec = makeExec(TOPOLOGY_SCRIPT_MAIN_NO_DEV, []);
    const ui = makeUi({
      selects: [
        "Run verification",
        "Yes, I have one", // claim a dev branch
      ],
      // Shell metacharacters + command substitution.
      inputs: ['dev$(touch /tmp/pwned)'],
    });
    const sessionDir = path.join(tmpDir, "session");
    fs.mkdirSync(sessionDir, { recursive: true });

    const result = (await runGitVerificationQa({
      exec,
      cwd,
      ui,
      sessionDir,
      now: () => "2026-05-14T00:00:00.000Z",
    })) as HarnessCiGitConfig;

    expect(result).not.toBeNull();
    // The unsafe name must NOT reach the spec.
    expect(result.devBranch).toBeNull();
    expect(result.enforceMainFromDevOnly).toBe(false);
    // A finding must record the rejection so the user understands why nothing happened.
    const unsafeFinding = result.verification!.findings.find((f) =>
      f.message.includes("unsafe dev branch name"),
    );
    expect(unsafeFinding).toBeDefined();
    expect(unsafeFinding!.severity).toBe("warning");
  });

  test("rejects an unsafe user-supplied main branch name when default is already a dev branch", async () => {
    const exec = makeExec(
      [
        {
          match: (cmd, args) => cmd === "git" && args[0] === "symbolic-ref",
          result: { stdout: "refs/remotes/origin/develop\n", code: 0 },
        },
        {
          match: (cmd, args) => cmd === "git" && args[0] === "branch",
          // No mainCandidates — neither `main` nor `master` listed, forcing the prompt.
          result: { stdout: "develop\nfeature\n", code: 0 },
        },
        {
          match: (cmd, args) => cmd === "git" && args[0] === "ls-remote",
          result: { stdout: "deadbeef\trefs/heads/develop\n", code: 0 },
        },
      ],
      [],
    );
    const ui = makeUi({
      selects: [
        "Run verification",
        "develop", // dev pick
      ],
      // Single-quote injection breaks the YAML expression `... == '<mainBranch>'`.
      inputs: ["main'; injected"],
    });
    const sessionDir = path.join(tmpDir, "session");
    fs.mkdirSync(sessionDir, { recursive: true });

    const result = (await runGitVerificationQa({
      exec,
      cwd,
      ui,
      sessionDir,
      now: () => "2026-05-14T00:00:00.000Z",
    })) as HarnessCiGitConfig;

    // dev was safe; main was rejected. The capture path must surface enforcement off
    // and a warning finding, never persist the dangerous name.
    expect(result.devBranch).toBe("develop");
    expect(result.enforceMainFromDevOnly).toBe(false);
    const unsafeFinding = result.verification!.findings.find((f) =>
      f.message.includes("unsafe main branch name"),
    );
    expect(unsafeFinding).toBeDefined();
  });
});
