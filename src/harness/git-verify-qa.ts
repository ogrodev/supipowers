/**
 * Interactive Git topology + branch-protection sub-step for `/supi:harness`.
 *
 * Pure-ish entry point: takes an `ExecFn`, a minimal UI interface, and a session dir, and
 * returns a populated `HarnessCiGitConfig` (or null when the user opts out). All side
 * effects — branch creation, ruleset POST, manual-instructions doc — are routed through
 * the dependencies so the harness command layer can drive it without changing.
 *
 * Why split this out of `src/harness/command.ts`? Two reasons:
 *  1. Testability. The command file is 1100+ LOC and pulls in the full platform/agent
 *     stack; we want a tight Q&A test surface that operates on a fake UI + scripted
 *     `exec` results.
 *  2. Separation of concerns. The command layer owns "when do we ask?", this module owns
 *     "what do we ask, and what do we do with the answers?".
 *
 * Decision tree (matches the user's spec):
 *  1. Detect topology (default branch + dev candidates).
 *  2. If default is `main`/`master`:
 *       a. "Do you have a development branch?"
 *          - Yes → "Which one?" (existing candidates or custom).
 *          - No  → "Do you want one?"
 *                  - Yes → "Name?" → "Create new from main, or promote existing?"
 *                  - No  → record devBranch=null, no enforcement.
 *  3. If default is *not* main/master, treat it as already-dev and ask the user to
 *     confirm + pick a separate "main" branch from the listed remotes.
 *  4. Optionally apply protections via gh; render manual-instructions doc on any
 *     skipped/failed protection step.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type {
  HarnessCiGitConfig,
  HarnessCiGitFinding,
} from "../types.js";
import {
  applyMainProtectionRuleset,
  createBranchFromRef,
  detectGitTopology,
  isSafeBranchName,
  renderManualInstructions,
  type ExecFn,
  type GhExecOutcome,
} from "./git-verification.js";

export interface GitVerifyQaUi {
  select: (title: string, options: string[]) => Promise<string | null>;
  input: (label: string) => Promise<string | null>;
  notify: (message: string, level?: "info" | "warning" | "error") => void;
}

export interface GitVerifyQaInput {
  exec: ExecFn;
  cwd: string;
  ui: GitVerifyQaUi;
  /** Absolute path to the harness session directory where manual instructions land. */
  sessionDir: string;
  /** Clock injection for deterministic tests. */
  now?: () => string;
}

const TOP_LEVEL_RUN = "Run verification";
const TOP_LEVEL_SKIP = "Skip";

/**
 * Capture-side validation for branch names that flow into the persisted design spec.
 * Any value that reaches `HarnessCiGitConfig.{mainBranch,devBranch}` is rendered into
 * the GitHub Actions workflow (single-quoted YAML expression and double-quoted shell
 * line). We accept only the strict subset defined by `isSafeBranchName` so the render
 * path stays escape-free and an injected branch name cannot break the workflow.
 *
 * Returns the trimmed name on success; pushes a finding and returns `null` otherwise.
 */
function captureBranchName(
  raw: string | null | undefined,
  role: "main" | "dev",
  findings: HarnessCiGitFinding[],
): string | null {
  const trimmed = raw?.trim() ?? "";
  if (trimmed.length === 0) return null;
  if (!isSafeBranchName(trimmed)) {
    findings.push({
      severity: "warning",
      message: `Rejected unsafe ${role} branch name: ${JSON.stringify(trimmed)}`,
      remediation:
        "Branch names must match [A-Za-z0-9._/-]+ (no whitespace, quotes, or shell metacharacters). " +
        "Re-run /supi:harness with a sanitized name.",
    });
    return null;
  }
  return trimmed;
}

/**
 * Drive the interactive Git verification flow.
 *
 * Returns:
 *  - `null` when the user opts out of running verification entirely.
 *  - A populated `HarnessCiGitConfig` otherwise. Even when sub-steps fail (gh missing,
 *    branch creation rejected by the remote), we return a config so the design spec
 *    captures the user's intent — the failures land in `verification.findings`.
 */
export async function runGitVerificationQa(
  input: GitVerifyQaInput,
): Promise<HarnessCiGitConfig | null> {
  const now = input.now ?? (() => new Date().toISOString());

  const topLevel = await input.ui.select(
    "Run Git branching verification now? (checks default branch, optional dev branch, and PR-source restrictions)",
    [TOP_LEVEL_RUN, TOP_LEVEL_SKIP],
  );
  if (topLevel !== TOP_LEVEL_RUN) {
    return null;
  }

  const topology = await detectGitTopology(input.exec, input.cwd);
  input.ui.notify(
    `Detected default branch: ${topology.mainBranch}` +
      (topology.devBranchCandidates.length > 0
        ? ` — dev candidates: ${topology.devBranchCandidates.join(", ")}`
        : ""),
    "info",
  );

  const findings: HarnessCiGitFinding[] = [];
  const appliedProtections: string[] = [];

  let mainBranch = topology.mainBranch;
  let devBranch: string | null = null;
  let enforceMainFromDevOnly = false;

  if (topology.defaultIsMainOrMaster) {
    const decision = await resolveDevBranchWhenDefaultIsMain(input, topology, findings, appliedProtections);
    devBranch = decision.devBranch;
    enforceMainFromDevOnly = decision.enforceMainFromDevOnly;
  } else {
    const decision = await resolveDevBranchWhenDefaultIsAlreadyDev(input, topology, findings);
    if (decision.mainBranch) mainBranch = decision.mainBranch;
    devBranch = decision.devBranch;
    enforceMainFromDevOnly = decision.enforceMainFromDevOnly;
  }

  // Attempt the server-side ruleset opportunistically when enforcement is on.
  if (enforceMainFromDevOnly && devBranch) {
    const outcome = await applyMainProtectionRuleset(input.exec, input.cwd, {
      mainBranch,
      devBranch,
    });
    foldRulesetOutcome(outcome, findings, appliedProtections);
  }

  // CI-side guardrail always applies when enforcement is on — recorded so the validate
  // stage can confirm the rendered workflow contains the verify-pr-source job.
  if (enforceMainFromDevOnly && devBranch) {
    appliedProtections.push("ci-guardrail");
  }

  // Manual-instructions doc lives at <session>/git-verification.md whenever any
  // protection step skipped or failed — gives the user a copy-pasteable fallback.
  const ghAvailable = appliedProtections.includes("ruleset");
  const needsManualDoc =
    enforceMainFromDevOnly && devBranch !== null && !ghAvailable;

  let manualInstructionsPath: string | null = null;
  if (needsManualDoc) {
    const md = renderManualInstructions({
      mainBranch,
      devBranch,
      enforceMainFromDevOnly,
      ghAvailable,
    });
    const rel = "git-verification.md";
    fs.mkdirSync(input.sessionDir, { recursive: true });
    fs.writeFileSync(path.join(input.sessionDir, rel), md, "utf8");
    manualInstructionsPath = rel;
    input.ui.notify(
      `Wrote manual Git verification steps to ${rel}.`,
      "info",
    );
  }

  return {
    mainBranch,
    devBranch,
    enforceMainFromDevOnly,
    verification: {
      checkedAt: now(),
      appliedProtections,
      findings,
      manualInstructionsPath,
    },
  };
}

// ---------------------------------------------------------------------------
// Decision sub-flows
// ---------------------------------------------------------------------------

interface DevDecision {
  devBranch: string | null;
  enforceMainFromDevOnly: boolean;
  /** Set by the "default is already dev" path; left undefined when the caller keeps the detected main. */
  mainBranch?: string;
}

async function resolveDevBranchWhenDefaultIsMain(
  input: GitVerifyQaInput,
  topology: Awaited<ReturnType<typeof detectGitTopology>>,
  findings: HarnessCiGitFinding[],
  appliedProtections: string[],
): Promise<DevDecision> {
  const hasOptions = topology.devBranchCandidates.length > 0;
  const haveDevPrompt = hasOptions
    ? "Yes — use " + topology.devBranchCandidates[0]
    : "Yes, I have one";
  const decision = await input.ui.select(
    "Do you have a development branch?",
    [haveDevPrompt, "No, I don't have one"],
  );

  if (decision && decision.startsWith("Yes")) {
    if (hasOptions) {
      const picked = topology.devBranchCandidates[0];
      const safe = captureBranchName(picked, "dev", findings);
      if (safe) return { devBranch: safe, enforceMainFromDevOnly: true };
      return { devBranch: null, enforceMainFromDevOnly: false };
    }
    const safe = captureBranchName(
      await input.ui.input("What is your development branch?"),
      "dev",
      findings,
    );
    if (safe) return { devBranch: safe, enforceMainFromDevOnly: true };
    findings.push({
      severity: "warning",
      message: "User claimed to have a dev branch but provided no usable name.",
      remediation: "Re-run /supi:harness and provide a valid branch name.",
    });
    return { devBranch: null, enforceMainFromDevOnly: false };
  }

  // No existing dev branch — ask if they want one.
  const wantsOne = await input.ui.select(
    "Do you want a dedicated development branch?",
    ["Yes — create one", "No, run CI on main only"],
  );
  if (!wantsOne || !wantsOne.startsWith("Yes")) {
    findings.push({
      severity: "info",
      message: "User opted out of a dedicated dev branch.",
      remediation: "Re-run /supi:harness if you change your mind.",
    });
    return { devBranch: null, enforceMainFromDevOnly: false };
  }

  const rawName = (await input.ui.input("What name? (default: dev)"))?.trim() || "dev";
  const name = captureBranchName(rawName, "dev", findings);
  if (!name) {
    return { devBranch: null, enforceMainFromDevOnly: false };
  }
  const action = await input.ui.select(
    `Create \`${name}\` from \`${topology.mainBranch}\`, or promote an existing branch?`,
    [
      "Create new branch from main",
      ...(topology.allBranches.length > 0 ? ["Promote an existing branch"] : []),
    ],
  );

  if (action === "Promote an existing branch") {
    const existingPick = await input.ui.select(
      "Pick the branch to promote:",
      topology.allBranches.filter((b) => b !== topology.mainBranch),
    );
    const safePick = captureBranchName(existingPick, "dev", findings);
    if (safePick) {
      return { devBranch: safePick, enforceMainFromDevOnly: true };
    }
    findings.push({
      severity: "warning",
      message: "No branch picked for promotion.",
      remediation: "Re-run /supi:harness to finish wiring the dev branch.",
    });
    return { devBranch: null, enforceMainFromDevOnly: false };
  }

  // Create new branch from main.
  const outcome = await createBranchFromRef(
    input.exec,
    input.cwd,
    name,
    `origin/${topology.mainBranch}`,
  );
  if (outcome.kind === "created" || outcome.kind === "already-exists") {
    appliedProtections.push("branch-created");
    if (outcome.kind === "already-exists") {
      findings.push({
        severity: "info",
        message: `Branch \`${name}\` already exists — reusing.`,
      });
    }
    return { devBranch: name, enforceMainFromDevOnly: true };
  }
  findings.push({
    severity: "error",
    message: `Failed to create branch \`${name}\`: ${outcome.reason}`,
    remediation: `Create the branch manually with: git switch -c ${name} origin/${topology.mainBranch} && git push -u origin ${name}`,
  });
  // Still record the user's intent so the design spec captures it; protections will be
  // rejected by validate.
  return { devBranch: name, enforceMainFromDevOnly: true };
}

async function resolveDevBranchWhenDefaultIsAlreadyDev(
  input: GitVerifyQaInput,
  topology: Awaited<ReturnType<typeof detectGitTopology>>,
  findings: HarnessCiGitFinding[],
): Promise<DevDecision> {
  const otherBranches = topology.allBranches.filter((b) => b !== topology.mainBranch);
  const pick = await input.ui.select(
    `\`${topology.mainBranch}\` looks like a development branch. Pick the *dev* branch the harness should target:`,
    [topology.mainBranch, ...otherBranches],
  );
  const devBranch = captureBranchName(pick ?? topology.mainBranch, "dev", findings);
  if (!devBranch) {
    return { devBranch: null, enforceMainFromDevOnly: false };
  }

  // Ask which branch is the protected main.
  const mainCandidates = topology.allBranches.filter(
    (b) => b === "main" || b === "master",
  );
  let mainBranch: string | null = mainCandidates[0] ?? "main";
  if (mainCandidates.length === 0) {
    const provided = await input.ui.input("What is your main/master branch?");
    if (provided && provided.trim().length > 0) {
      mainBranch = captureBranchName(provided, "main", findings);
    }
  }
  if (!mainBranch) {
    return { devBranch, enforceMainFromDevOnly: false };
  }

  if (mainBranch === devBranch) {
    findings.push({
      severity: "warning",
      message: "Main branch and dev branch are the same; PR-source restriction will be disabled.",
      remediation: "Re-run /supi:harness and pick distinct branches.",
    });
    return { devBranch, mainBranch, enforceMainFromDevOnly: false };
  }

  return { devBranch, mainBranch, enforceMainFromDevOnly: true };
}

function foldRulesetOutcome(
  outcome: GhExecOutcome,
  findings: HarnessCiGitFinding[],
  appliedProtections: string[],
): void {
  switch (outcome.kind) {
    case "applied":
      appliedProtections.push("ruleset");
      return;
    case "skipped":
      switch (outcome.reason) {
        case "no-cli":
          findings.push({
            severity: "warning",
            message: "`gh` CLI is not installed; could not apply server-side ruleset.",
            remediation: "Install gh (https://cli.github.com/) and re-run /supi:harness, or follow the manual steps.",
          });
          return;
        case "no-auth":
          findings.push({
            severity: "warning",
            message: "`gh` is not authenticated; could not apply server-side ruleset.",
            remediation: "Run `gh auth login --scopes admin:repo` and re-run /supi:harness.",
          });
          return;
        case "no-permission":
          findings.push({
            severity: "warning",
            message: "`gh` lacks `admin:repo` scope; could not apply server-side ruleset.",
            remediation: "Run `gh auth refresh -s admin:repo` and re-run /supi:harness, or follow the manual steps.",
          });
          return;
        case "no-repo":
          findings.push({
            severity: "info",
            message: "Could not detect GitHub repo from `gh repo view`; skipping ruleset.",
            remediation: "Confirm the repository is connected to GitHub (gh repo view should print owner/repo).",
          });
          return;
        case "no-dev-branch":
          return; // Should be unreachable here — we gate on devBranch above.
      }
    case "failed":
      findings.push({
        severity: "error",
        message: `Ruleset API call failed: ${outcome.reason}`,
        remediation: "Inspect the failure and apply the ruleset manually via Settings → Rules → Rulesets.",
      });
      return;
  }
}
