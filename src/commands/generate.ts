import type { Platform } from "../platform/types.js";
import type { DocDriftState } from "../types.js";
import { notifyInfo, notifyError, notifyWarning } from "../notifications/renderer.js";
import {
  loadState,
  saveState,
  discoverDocFiles,
  getHeadCommit,
  getDiffFilesSince,
  getDiffSince,
  readTrackedDocs,
  buildFirstRunPrompt,
  buildSubsequentRunPrompt,
} from "../docs/drift.js";

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
