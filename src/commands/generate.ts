import type { Platform } from "../platform/types.js";
import type { DriftCheckResult } from "../types.js";
import { notifyInfo, notifyError, notifyWarning } from "../notifications/renderer.js";
import {
  loadState,
  saveState,
  discoverDocFiles,
  getHeadCommit,
  checkDocDrift,
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

  // First run: discover and select files, then steer main thread for full audit
  if (state.trackedFiles.length === 0) {
    const discovered = await discoverDocFiles(platform, cwd);
    if (discovered.length === 0) {
      notifyWarning(ctx, "No documentation files found in this repository");
      return;
    }

    const selected = await selectDocFiles(ctx, discovered);
    if (selected.length === 0) {
      notifyInfo(ctx, "No files selected \u2014 doc tracking not set up");
      return;
    }

    // Persist tracked files but leave lastCommit null \u2014 updated after fix starts
    saveState(paths, cwd, {
      trackedFiles: selected,
      lastCommit: null,
      lastRunAt: new Date().toISOString(),
    });

    // Steer the main thread to audit and fix docs directly
    const docList = selected.map((f) => `- \`${f}\``).join("\n");
    const prompt = [
      `Check these documentation files for accuracy against the current codebase:`,
      ``,
      docList,
      ``,
      `<critical>`,
      `You MUST read skill://create-readme before assessing documentation quality.`,
      `</critical>`,
      ``,
      `Read each documentation file and compare against the current codebase. Look for:`,
      `1. **Factual inaccuracies**: wrong names, missing parameters, removed features, changed behavior, outdated examples`,
      `2. **Missing documentation**: new commands, features, config options that exist in code but not in docs`,
      `3. **Structural gaps**: important sections that should exist based on the codebase but don't`,
      ``,
      `For each issue found, fix it directly in the documentation file. Do NOT output JSON or a report \u2014 just fix the files.`,
      `If documentation is accurate, say so and make no changes.`,
      ``,
      `Rules:`,
      `- Only fix factual inaccuracies and add missing sections for undocumented features`,
      `- Do NOT rewrite prose, improve wording, or restructure existing content`,
      `- Preserve each document's existing formatting, tone, and conventions`,
    ].join("\n");
    notifyInfo(ctx, "Starting full documentation audit", `${selected.length} file(s) selected`);

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

  // Subsequent run: headless sub-agent drift check
  const result = await checkDocDrift(platform, cwd);

  if (!result || !result.drifted) {
    notifyInfo(ctx, "Docs are up to date", result?.summary ?? "No changes since last check");
    return;
  }

  // Build lightweight steer summary from findings
  const steer = buildSteerSummary(result);
  notifyInfo(ctx, "Documentation drift detected", `${result.findings.length} finding(s)`);

  // Update state only now \u2014 user has seen findings and we\u2019re about to fix.
  const head = await getHeadCommit(platform, cwd);
  const currentState = loadState(paths, cwd);
  saveState(paths, cwd, { ...currentState, lastCommit: head, lastRunAt: new Date().toISOString() });

  platform.sendMessage(
    {
      customType: "supi-generate-docs",
      content: [{ type: "text", text: steer }],
      display: "none",
    },
    { deliverAs: "steer", triggerTurn: true },
  );
}

function buildSteerSummary(result: DriftCheckResult): string {
  const lines: string[] = ["Documentation drift detected. Please fix the following issues:", ""];

  const byFile = new Map<string, typeof result.findings>();
  for (const f of result.findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file)!.push(f);
  }

  for (const [file, findings] of byFile) {
    lines.push(`### \`${file}\``);
    for (const f of findings) {
      lines.push(`- [${f.severity}] ${f.description}`);
    }
    lines.push("");
  }

  lines.push("Read each file, apply the fixes, and write the corrected content.");
  return lines.join("\n");
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
