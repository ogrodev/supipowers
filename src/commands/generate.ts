import * as fs from "node:fs";
import * as path from "node:path";
import type { Platform, PlatformPaths } from "../platform/types.js";
import type { DocDriftState } from "../types.js";
import { notifyInfo, notifyError, notifyWarning } from "../notifications/renderer.js";

// ── State persistence ─────────────────────────────────────────

const STATE_FILENAME = "doc-drift.json";

const EMPTY_STATE: DocDriftState = {
  trackedFiles: [],
  lastCommit: null,
  lastRunAt: null,
};

export function statePath(paths: PlatformPaths, cwd: string): string {
  return paths.project(cwd, STATE_FILENAME);
}

export function loadState(paths: PlatformPaths, cwd: string): DocDriftState {
  const file = statePath(paths, cwd);
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as DocDriftState;
  } catch {
    return { ...EMPTY_STATE, trackedFiles: [] };
  }
}

export function saveState(paths: PlatformPaths, cwd: string, state: DocDriftState): void {
  const file = statePath(paths, cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n");
}

// ── File discovery ────────────────────────────────────────────

/** Known documentation file patterns to discover via git ls-files */
const DOC_GLOBS = ["*.md", "*.txt", "*.rst", "docs/*", "*.mdx"];

export async function discoverDocFiles(
  platform: Platform,
  cwd: string,
): Promise<string[]> {
  const result = await platform.exec(
    "git",
    ["ls-files", "--", ...DOC_GLOBS],
    { cwd },
  );
  if (result.code !== 0) return [];

  const files = result.stdout
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => f.length > 0);

  // Deduplicate (globs may overlap)
  return [...new Set(files)].sort();
}

// ── Git helpers ───────────────────────────────────────────────

async function getHeadCommit(
  platform: Platform,
  cwd: string,
): Promise<string | null> {
  const result = await platform.exec("git", ["rev-parse", "HEAD"], { cwd });
  if (result.code !== 0) return null;
  return result.stdout.trim() || null;
}

async function getDiffFilesSince(
  platform: Platform,
  cwd: string,
  sinceCommit: string,
): Promise<string[]> {
  const result = await platform.exec(
    "git",
    ["diff", "--name-only", `${sinceCommit}..HEAD`],
    { cwd },
  );
  if (result.code !== 0) return [];
  return result.stdout
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
}

async function getDiffSince(
  platform: Platform,
  cwd: string,
  sinceCommit: string,
  files: string[],
): Promise<string> {
  const result = await platform.exec(
    "git",
    ["diff", `${sinceCommit}..HEAD`, "--", ...files],
    { cwd },
  );
  if (result.code !== 0) return "";
  return result.stdout;
}

// ── Multi-select UI ───────────────────────────────────────────

async function selectDocFiles(
  ctx: any,
  discovered: string[],
): Promise<string[]> {
  const selected = new Set<string>();

  while (true) {
    const options = discovered.map(
      (f) => `${selected.has(f) ? "◉" : "○"} ${f}`,
    );
    options.push("─── Add manually ───");
    options.push("─── Done ───");

    const choice = await ctx.ui.select("Track these docs", options, {
      helpText: `${selected.size} selected · Toggle files · Done when ready`,
    });

    if (choice === undefined || choice === null || choice === "─── Done ───") break;

    if (choice === "─── Add manually ───") {
      const filePath = await ctx.ui.input("File path (relative to project root)");
      if (filePath) selected.add(filePath);
      continue;
    }

    const file = choice.replace(/^[○◉] /, "");
    if (selected.has(file)) {
      selected.delete(file);
    } else {
      selected.add(file);
    }
  }

  return [...selected];
}

// ── Prompt builders ───────────────────────────────────────────

function readTrackedDocs(cwd: string, files: string[]): Map<string, string> {
  const docs = new Map<string, string>();
  for (const file of files) {
    const abs = path.join(cwd, file);
    try {
      docs.set(file, fs.readFileSync(abs, "utf-8"));
    } catch {
      // File was deleted — still include it so the LLM knows
      docs.set(file, "[FILE DELETED]");
    }
  }
  return docs;
}

const DRIFT_INSTRUCTIONS = `You are a documentation accuracy checker. Your job is to compare tracked documentation files against the current codebase and identify drift.

Rules:
1. Only flag factual inaccuracies: wrong names, missing parameters, removed features, changed behavior, outdated examples
2. Also flag missing documentation: new commands, new features, new config options, new subcommands that are not documented at all — suggest adding new sections where appropriate
3. Do NOT rewrite prose, improve wording, add explanations, or restructure existing content
4. Preserve each document's existing formatting, tone, and conventions
5. If a document is already accurate and complete, say so — do not touch it
6. Present findings as a summary overview: describe what needs to change in plain language, do NOT produce diffs or code blocks with +/- lines
7. Keep it concise — state the problem, the correct value, and which file needs the change`;

export function buildFirstRunPrompt(docs: Map<string, string>): string {
  const parts = [DRIFT_INSTRUCTIONS, "", "## Tracked documentation files", ""];
  for (const [file, content] of docs) {
    parts.push(`### ${file}`, "```", content, "```", "");
  }
  parts.push(
    "Check whether any of these documents have drifted from the current codebase.",
    "Look for both inaccuracies in existing content AND missing documentation for features that exist in code but are not documented.",
    "Present your findings as a plain-language summary — no diffs.",
  );
  return parts.join("\n");
}

export function buildSubsequentRunPrompt(
  diff: string,
  docs: Map<string, string>,
): string {
  const parts = [DRIFT_INSTRUCTIONS, "", "## Code changes since last check", "```diff", diff, "```", ""];
  parts.push("## Tracked documentation files", "");
  for (const [file, content] of docs) {
    parts.push(`### ${file}`, "```", content, "```", "");
  }
  parts.push(
    "Based on the code changes above, determine if any tracked documentation needs updating.",
    "Look for both inaccuracies introduced by the changes AND new features or commands that should be documented but are missing.",
    "Present your findings as a plain-language summary — no diffs.",
  );
  return parts.join("\n");
}

// ── Subcommand: docs ──────────────────────────────────────────

async function handleDocs(platform: Platform, ctx: any): Promise<void> {
  if (!ctx.hasUI) {
    notifyWarning(ctx, "Doc drift check requires interactive mode");
    return;
  }

  const cwd = ctx.cwd;
  const { paths } = platform;
  const state = loadState(paths, cwd);
  const isFirstRun = state.trackedFiles.length === 0;

  if (isFirstRun) {
    await handleFirstRun(platform, ctx, cwd);
  } else {
    await handleSubsequentRun(platform, ctx, cwd, state);
  }
}

async function handleFirstRun(
  platform: Platform,
  ctx: any,
  cwd: string,
): Promise<void> {
  const { paths } = platform;

  // Discover doc files
  const discovered = await discoverDocFiles(platform, cwd);
  if (discovered.length === 0) {
    notifyWarning(ctx, "No documentation files found in this repository");
    return;
  }

  // Let user select which files to track
  const selected = await selectDocFiles(ctx, discovered);
  if (selected.length === 0) {
    notifyInfo(ctx, "No files selected — doc tracking not set up");
    return;
  }

  // Read selected docs and build initial drift-check prompt
  const docs = readTrackedDocs(cwd, selected);
  const prompt = buildFirstRunPrompt(docs);

  // Save state with selected files and current commit
  const head = await getHeadCommit(platform, cwd);
  saveState(paths, cwd, {
    trackedFiles: selected,
    lastCommit: head,
    lastRunAt: new Date().toISOString(),
  });

  notifyInfo(ctx, "Doc drift check started", `Tracking ${selected.length} file(s)`);

  platform.sendMessage(
    {
      customType: "supi-generate-docs",
      content: [{ type: "text", text: prompt }],
      display: "none",
    },
    { deliverAs: "steer", triggerTurn: true },
  );
}

async function handleSubsequentRun(
  platform: Platform,
  ctx: any,
  cwd: string,
  state: DocDriftState,
): Promise<void> {
  const { paths } = platform;

  if (!state.lastCommit) {
    // State exists but no commit recorded — treat as first run with known files
    notifyWarning(ctx, "No previous commit recorded — running full check");
    const docs = readTrackedDocs(cwd, state.trackedFiles);
    const prompt = buildFirstRunPrompt(docs);
    const head = await getHeadCommit(platform, cwd);
    saveState(paths, cwd, { ...state, lastCommit: head, lastRunAt: new Date().toISOString() });

    platform.sendMessage(
      {
        customType: "supi-generate-docs",
        content: [{ type: "text", text: prompt }],
        display: "none",
      },
      { deliverAs: "steer", triggerTurn: true },
    );
    return;
  }

  // Check what changed since last commit
  const changedFiles = await getDiffFilesSince(platform, cwd, state.lastCommit);
  if (changedFiles.length === 0) {
    notifyInfo(ctx, "No changes since last check");
    return;
  }

  // Get the actual diff for non-doc code changes (context for the LLM)
  const diff = await getDiffSince(platform, cwd, state.lastCommit, changedFiles);
  if (!diff) {
    notifyInfo(ctx, "No meaningful diff since last check");
    return;
  }

  // Read current content of tracked docs
  const docs = readTrackedDocs(cwd, state.trackedFiles);
  const prompt = buildSubsequentRunPrompt(diff, docs);

  // Update state
  const head = await getHeadCommit(platform, cwd);
  saveState(paths, cwd, { ...state, lastCommit: head, lastRunAt: new Date().toISOString() });

  notifyInfo(ctx, "Checking docs for drift", `${changedFiles.length} file(s) changed since last check`);

  platform.sendMessage(
    {
      customType: "supi-generate-docs",
      content: [{ type: "text", text: prompt }],
      display: "none",
    },
    { deliverAs: "steer", triggerTurn: true },
  );
}

// ── Command registration ──────────────────────────────────────

const SUBCOMMANDS = [
  { name: "docs", description: "Check documentation for drift from codebase" },
] as const;

export function registerGenerateCommand(platform: Platform): void {
  platform.registerCommand("supi:generate", {
    description: "Generation utilities — docs drift detection",
    getArgumentCompletions(prefix: string) {
      const lower = prefix.toLowerCase();
      const matches = SUBCOMMANDS
        .filter((s) => s.name.startsWith(lower))
        .map((s) => ({ value: `${s.name} `, label: s.name, description: s.description }));
      return matches.length > 0 ? matches : null;
    },
    async handler(args: string | undefined, ctx: any) {
      const subcommand = args?.trim().split(/\s+/)[0] ?? "docs";

      switch (subcommand) {
        case "docs":
          await handleDocs(platform, ctx);
          break;
        default:
          notifyError(
            ctx,
            `Unknown subcommand "${subcommand}"`,
            `Available: ${SUBCOMMANDS.map((s) => s.name).join(", ")}`,
          );
      }
    },
  });
}
