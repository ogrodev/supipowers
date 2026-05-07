import * as fs from "node:fs";
import * as path from "node:path";
import type { Platform, PlatformContext } from "../platform/types.js";
import { systemPromptText } from "../platform/system-prompt.js";
import {
  parseSystemPrompt,
  parseIndividualSkills,
} from "../context/analyzer.js";
import type { ParsedSkill, PromptSection } from "../context/analyzer.js";
import {
  detectTechStack,
  buildContextReport,
} from "../context/optimizer.js";
import type { ContextReport } from "../context/optimizer.js";
import {
  buildOptimizationPlan,
} from "../context/startup-optimizer.js";
import type {
  ManualOptimizationAction,
  OptimizationPlan,
  WriteRuleAction,
} from "../context/startup-optimizer.js";
import { parseManagedRule, renderManagedRule } from "../context/rule-renderer.js";
import { DEFAULT_TOKENIGNORE_ENTRIES, mergeManagedTokenignore } from "../context/tokenignore.js";
import {
  parseStartupOptimizerManifest,
  runStartupCheck,
} from "../context/startup-check.js";
import type { StartupCheckReport, StartupOptimizerManifest } from "../context/startup-check.js";
import { getMetricsStore, getSessionId } from "../context-mode/hooks.js";

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

interface OptimizeContextArgs {
  apply: boolean;
  check: boolean;
  dryRun: boolean;
}

function parseOptimizeContextArgs(args: string | undefined): OptimizeContextArgs {
  const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
  return {
    apply: tokens.includes("--apply"),
    check: tokens.includes("--check"),
    dryRun: tokens.includes("--dry-run"),
  };
}

/**
 * Handle the `/supi:optimize-context` command. Returns a Promise so that callers
 * (and tests) can await the full flow; the registered command handler does not
 * need to await — exceptions are caught and surfaced via `ctx.ui.notify`.
 */
export async function handleOptimizeContext(
  platform: Platform,
  ctx: PlatformContext,
  args?: string,
): Promise<void> {
  if (!ctx.hasUI) return;

  try {
    const parsedArgs = parseOptimizeContextArgs(args);
    const systemPrompt = readSystemPrompt(ctx);

    if (parsedArgs.check) {
      await runCheck(platform, ctx, systemPrompt);
      return;
    }

    if (!systemPrompt) {
      ctx.ui.notify("System prompt unavailable", "warning");
      return;
    }

    const techStack = await detectTechStack(platform, ctx.cwd);
    const sections = parseSystemPrompt(systemPrompt);
    const skills = parseIndividualSkills(systemPrompt);
    const report = buildContextReport(sections, skills, techStack);
    const plan = buildOptimizationPlan({
      prompt: systemPrompt,
      sections,
      skills,
      techStack,
    });

    if (parsedArgs.dryRun) {
      await showDryRun(ctx, plan);
      return;
    }

    if (parsedArgs.apply) {
      await applyOptimizationPlan(platform, ctx, plan);
      return;
    }

    await showReport(platform, ctx, report, plan);
  } catch (err) {
    ctx.ui.notify(`Optimize error: ${(err as Error).message}`, "error");
  }
}

export function registerOptimizeContextCommand(platform: Platform): void {
  platform.registerCommand("supi:optimize-context", {
    description: "Analyze context usage and suggest token optimizations",
    async handler(args: string | undefined, ctx: any) {
      await handleOptimizeContext(platform, ctx, args);
    },
  });
}

// ── Internal ──────────────────────────────────────────────

function readSystemPrompt(ctx: PlatformContext): string | null {
  try {
    const value = (ctx as any).getSystemPrompt?.();
    const text = systemPromptText(value);
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

async function runCheck(
  platform: Platform,
  ctx: PlatformContext,
  currentPrompt: string | null,
): Promise<void> {
  const manifestPath = platform.paths.project(ctx.cwd, "context-optimizer", "manifest.json");
  const tokenignorePath = platform.paths.project(ctx.cwd, ".tokenignore");
  const manifestText = readOptionalFile(manifestPath);
  // Use the same parser the checker uses so the command cannot accept a manifest
  // shape that the check would later reject.
  const parsedManifest = parseStartupOptimizerManifest(manifestText, manifestPath);
  const manifest = typeof parsedManifest === "string" ? null : parsedManifest;

  const ruleFiles: Record<string, string | null> = {};
  if (manifest) {
    for (const rule of manifest.rules) {
      ruleFiles[rule.path] = readOptionalFile(path.join(ctx.cwd, rule.path));
    }
  }

  const currentSkills: ParsedSkill[] = currentPrompt ? parseIndividualSkills(currentPrompt) : [];
  const currentSections: PromptSection[] = currentPrompt ? parseSystemPrompt(currentPrompt) : [];

  const report = runStartupCheck({
    manifestPath,
    manifestText,
    ruleFiles,
    tokenignorePath,
    tokenignoreText: readOptionalFile(tokenignorePath),
    currentPrompt,
    currentSkills,
    currentSections,
  });

  if (report.status === "pass") {
    recordStartupOptimizerMetric(report);
  }

  ctx.ui.notify(formatCheckReport(report), report.status === "pass" ? "info" : "error");
}

function readOptionalFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function formatCheckReport(report: StartupCheckReport): string {
  const lines = [`Startup optimization check: ${report.status}`];
  if (report.currentBytes != null) {
    lines.push(`Current prompt: ${report.currentBytes} bytes (~${formatTokens(Math.ceil(report.currentBytes / 4))} tokens estimated)`);
  }
  if (report.targetBytes != null) {
    lines.push(`Target: ${report.targetBytes} bytes (~${formatTokens(Math.ceil(report.targetBytes / 4))} tokens estimated)`);
  }
  if (report.issues.length > 0) {
    lines.push("Issues:");
    for (const issue of report.issues) {
      const location = issue.path ? ` at ${issue.path}` : issue.sourceId ? ` for ${issue.sourceId}` : "";
      lines.push(`- ${issue.reason}${location}: ${issue.remediation}`);
    }
    if (report.issues.some((entry) => RUNTIME_DEPENDENT_REASONS.has(entry.reason))) {
      lines.push(
        "Note: rule discovery happens at OMP process startup. If you just ran --apply, restart OMP before running --check so the runtime actually picks up the managed rules in .omp/rules.",
      );
    }
  }
  return lines.join("\n");
}

const RUNTIME_DEPENDENT_REASONS = new Set([
  "still-loaded-source",
  "prompt-over-target",
  "unresolved-manual-action",
]);

function recordStartupOptimizerMetric(report: StartupCheckReport): void {
  const store = getMetricsStore();
  if (!store || report.currentBytes == null || report.beforeBytes == null) return;
  try {
    store.record({
      session_id: getSessionId() || "startup-optimizer-check",
      ts: Date.now(),
      layer: "L6",
      tool: "(system)",
      processor: "startup-optimizer",
      before_bytes: report.beforeBytes,
      after_bytes: report.currentBytes,
      cache_hit: 0,
      unique_source_hash: report.sourceSetHash,
      context_tokens: null,
      context_window: null,
      context_percent: null,
    });
  } catch {
    // Metrics are best-effort; check results must still be surfaced.
  }
}

async function showDryRun(ctx: PlatformContext, plan: OptimizationPlan): Promise<void> {
  const lines = buildPlanPreview(plan);
  await ctx.ui.select("Context Optimization Dry Run", lines, {
    helpText: "Dry-run: no files will be written · Esc to close",
  });
}

function buildPlanPreview(plan: OptimizationPlan): string[] {
  const writeRuleCount = plan.actions.filter((action) => action.kind === "write-rule").length;
  const manualCount = plan.actions.filter((action) => action.kind !== "write-rule").length;
  const lines = [
    `Source set: ${plan.sourceSetHash.slice(0, 12)}`,
    `Current: ~${formatTokens(Math.ceil(plan.beforeBytes / 4))} tokens  |  Estimated after planned removals: ~${formatTokens(Math.ceil(plan.estimatedAfterBytes / 4))} tokens`,
    `Actions: ${writeRuleCount} write-rule, ${manualCount} manual`,
    "",
  ];

  for (const action of plan.actions) {
    if (action.kind === "write-rule") {
      lines.push(`write-rule ${action.mode}: ${action.targetPath}`);
    } else if (action.kind === "manual-disable") {
      lines.push(`manual-disable ${action.sourceName}: ${action.reason}`);
    } else {
      lines.push(`manual-agents-split ${action.sourceName}: ${action.sourceBytes} bytes`);
    }
  }

  lines.push("", "Close");
  return lines;
}

async function applyOptimizationPlan(
  platform: Platform,
  ctx: PlatformContext,
  plan: OptimizationPlan,
): Promise<void> {
  const manifestPath = platform.paths.project(ctx.cwd, "context-optimizer", "manifest.json");
  const tokenignorePath = platform.paths.project(ctx.cwd, ".tokenignore");
  const manifestPreflight = preflightExistingManifest(manifestPath);
  if (manifestPreflight) {
    ctx.ui.notify(manifestPreflight, "error");
    return;
  }

  const writeRules = plan.actions.filter((action): action is WriteRuleAction => action.kind === "write-rule");
  const preflight = preflightRuleWrites(ctx.cwd, writeRules);
  if (preflight.conflicts.length > 0) {
    ctx.ui.notify(`Apply blocked: ${preflight.conflicts.join("; ")}`, "error");
    return;
  }

  if (fs.existsSync(tokenignorePath) && !fs.statSync(tokenignorePath).isFile()) {
    ctx.ui.notify(`Apply blocked: ${tokenignorePath} is not a file.`, "error");
    return;
  }

  const summary = buildApplySummary(plan, preflight.updates);
  const accepted = await confirmApply(ctx, summary);
  if (!accepted) {
    ctx.ui.notify("Apply cancelled.", "info");
    return;
  }

  const manifest = buildManifest(plan);
  const tokenignoreExisting = fs.existsSync(tokenignorePath)
    ? fs.readFileSync(tokenignorePath, "utf-8")
    : null;
  const tokenignore = mergeManagedTokenignore(tokenignoreExisting, DEFAULT_TOKENIGNORE_ENTRIES);

  try {
    for (const action of writeRules) {
      const target = absoluteRulePath(ctx.cwd, action.targetPath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, renderManagedRule(action));
    }

    fs.mkdirSync(path.dirname(tokenignorePath), { recursive: true });
    fs.writeFileSync(tokenignorePath, tokenignore.content);

    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) {
    ctx.ui.notify(`Apply failed before manifest completion: ${(error as Error).message}`, "error");
    return;
  }

  // OMP discovers rules during session construction (sdk.ts `createAgentSession`)
  // and the in-process rebuild callback reuses captured rule arrays. Neither
  // `ctx.reload()` nor `newSession()` re-runs that discovery, so the current
  // process can't see the just-written .omp/rules without a full restart.
  // Be honest about this rather than silently calling reload() and lying.
  ctx.ui.notify(
    "Applied deterministic context migration. Restart OMP so the new managed rules in .omp/rules are picked up by rule discovery, then disable the original sources and run /supi:optimize-context --check to validate runtime savings.",
    "info",
  );
}

function preflightExistingManifest(manifestPath: string): string | null {
  if (!fs.existsSync(manifestPath)) return null;
  if (!fs.statSync(manifestPath).isFile()) {
    return `Remove or repair ${manifestPath}: existing manifest path is not a file.`;
  }
  const text = fs.readFileSync(manifestPath, "utf-8");
  const parsed = parseStartupOptimizerManifest(text, manifestPath);
  if (typeof parsed === "string") {
    return `Remove or repair malformed startup optimizer manifest at ${manifestPath} before applying.`;
  }
  return null;
}

function preflightRuleWrites(
  cwd: string,
  actions: WriteRuleAction[],
): { conflicts: string[]; updates: string[] } {
  const conflicts: string[] = [];
  const updates: string[] = [];

  for (const action of actions) {
    const target = absoluteRulePath(cwd, action.targetPath);
    if (!fs.existsSync(target)) continue;
    const stat = fs.statSync(target);
    if (!stat.isFile()) {
      conflicts.push(`${action.targetPath} exists and is not a file`);
      continue;
    }

    const parsed = parseManagedRule(fs.readFileSync(target, "utf-8"));
    if (parsed.status === "unmanaged") {
      conflicts.push(`${action.targetPath} is unmanaged`);
      continue;
    }
    if (parsed.status === "malformed") {
      conflicts.push(`${action.targetPath} is malformed: ${parsed.error}`);
      continue;
    }
    if (
      parsed.metadata.sourceHash !== action.sourceHash ||
      parsed.metadata.sourceId !== action.sourceId ||
      parsed.metadata.mode !== action.mode
    ) {
      updates.push(action.targetPath);
    }
  }

  return { conflicts, updates };
}

function buildApplySummary(plan: OptimizationPlan, updates: string[]): string {
  const writeRuleCount = plan.actions.filter((action) => action.kind === "write-rule").length;
  const manualCount = plan.actions.filter((action) => action.kind !== "write-rule").length;
  const lines = [
    `Write ${writeRuleCount} managed rule file${writeRuleCount === 1 ? "" : "s"}.`,
    `Merge ${DEFAULT_TOKENIGNORE_ENTRIES.length} managed .tokenignore entries.`,
    `Record ${manualCount} manual follow-up action${manualCount === 1 ? "" : "s"}.`,
    `Estimated savings after planned removals: ~${formatTokens(Math.ceil(plan.estimatedSavedBytes / 4))} tokens.`,
  ];
  if (updates.length > 0) {
    lines.push(`Managed update candidate${updates.length === 1 ? "" : "s"}: ${updates.join(", ")}`);
  }
  lines.push("Manifest is written last after managed rule and tokenignore writes succeed.");
  return lines.join("\n");
}

async function confirmApply(ctx: PlatformContext, summary: string): Promise<boolean> {
  const choice = await ctx.ui.select("Apply deterministic context migration?", ["Apply", "Cancel"], {
    helpText: summary,
  });
  return choice === "Apply";
}

function buildManifest(plan: OptimizationPlan): StartupOptimizerManifest {
  const tokenignore = mergeManagedTokenignore(null, DEFAULT_TOKENIGNORE_ENTRIES);
  const rules = plan.actions
    .filter((action): action is WriteRuleAction => action.kind === "write-rule")
    .map((action) => ({
      path: action.targetPath,
      mode: action.mode,
      sourceId: action.sourceId,
      sourceName: action.sourceName,
      sourceHash: action.sourceHash,
      slug: action.slug,
      sourceBytes: action.sourceBytes,
      ...(action.condition ? { condition: action.condition } : {}),
      ...(action.description ? { description: action.description } : {}),
    }));

  return {
    version: 1,
    targetBytes: plan.targetBytes,
    sourceSetHash: plan.sourceSetHash,
    beforeBytes: plan.beforeBytes,
    estimatedAfterBytes: plan.estimatedAfterBytes,
    estimatedSavedBytes: plan.estimatedSavedBytes,
    rules,
    tokenignore: {
      path: ".omp/supipowers/.tokenignore",
      entries: tokenignore.entries,
      hash: tokenignore.hash,
    },
    manualActions: plan.actions.filter((action): action is ManualOptimizationAction => action.kind !== "write-rule"),
  };
}

function absoluteRulePath(cwd: string, targetPath: string): string {
  return path.join(cwd, targetPath);
}

async function showReport(
  platform: Platform,
  ctx: PlatformContext,
  report: ContextReport,
  plan: OptimizationPlan,
): Promise<void> {
  const techList = [
    ...report.techStack.languages,
    ...(report.techStack.runtime ? [report.techStack.runtime] : []),
    ...report.techStack.frameworks,
    ...report.techStack.tools,
  ].join(", ");

  const lines: string[] = [
    `Tech: ${techList || "unknown"}`,
    `Current: ~${formatTokens(report.totalTokens)} tokens  |  Target: ~8.0K tokens`,
    "",
  ];

  if (report.skills.length === 0) {
    lines.push("No skills detected in system prompt.");
  } else {
    const totalSkillTokens = report.skills.reduce((sum, s) => sum + s.tokens, 0);
    lines.push(`Skills (${report.skills.length} loaded, ~${formatTokens(totalSkillTokens)} tok total):`);
    lines.push("");

    const sorted = [...report.skills].sort((a, b) => b.tokens - a.tokens);
    for (const s of sorted) {
      lines.push(`  ${s.name.padEnd(32)} ~${formatTokens(s.tokens)} tok`);
    }
  }

  if (report.sections.length > 0) {
    lines.push("");
    lines.push("Other sections:");
    lines.push("");

    for (const sec of report.sections) {
      const tok = formatTokens(sec.tokens);
      const note = sec.note ? `  (${sec.note})` : "";
      lines.push(`  ${sec.label.padEnd(28)} ~${tok} tok${note}`);
    }
  }

  const message = lines.join("\n");

  const choice = await ctx.ui.select(
    "Context Optimization",
    [message, "▶ Optimize with AI", "Apply deterministic migration", "Run check", "Close"],
    { helpText: "Select an action · Esc to close" },
  );

  if (!choice || choice === "Close") return;
  if (choice === "Apply deterministic migration") {
    await applyOptimizationPlan(platform, ctx, plan);
    return;
  }
  if (choice === "Run check") {
    await runCheck(platform, ctx, readSystemPrompt(ctx));
    return;
  }
  if (!choice.includes("Optimize")) return;

  platform.sendMessage(
    {
      customType: "optimize-context",
      content: [{ type: "text", text: buildOptimizationPrompt(report) }],
      display: "none",
    },
    { deliverAs: "steer", triggerTurn: true },
  );
}

function buildOptimizationPrompt(report: ContextReport): string {
  const lines: string[] = [];

  const techList = [
    ...report.techStack.languages,
    ...(report.techStack.runtime ? [report.techStack.runtime] : []),
    ...report.techStack.frameworks,
    ...report.techStack.tools,
  ].join(", ");

  lines.push("# Context Optimization Request");
  lines.push("");
  lines.push(`Current system prompt is **~${formatTokens(report.totalTokens)} tokens**. Target is **< 8K tokens**.`);
  lines.push(`Project tech stack: **${techList || "unknown"}**`);
  lines.push("");

  if (report.skills.length > 0) {
    lines.push("## Skills currently loaded");
    lines.push("");
    lines.push("| Skill | Tokens |");
    lines.push("|-------|--------|");
    const sorted = [...report.skills].sort((a, b) => b.tokens - a.tokens);
    for (const s of sorted) {
      lines.push(`| ${s.name} | ~${formatTokens(s.tokens)} |`);
    }
    lines.push("");
  }

  if (report.sections.length > 0) {
    lines.push("## Other prompt sections");
    lines.push("");
    for (const sec of report.sections) {
      const note = sec.note ? ` — ${sec.note}` : "";
      lines.push(`- **${sec.label}**: ~${formatTokens(sec.tokens)} tok${note}`);
    }
    lines.push("");
  }

  lines.push("## Your task");
  lines.push("");
  lines.push("Classify each loaded skill into one of these actions:");
  lines.push("");
  lines.push("| Action | Prompt cost | When to use |");
  lines.push("|--------|-------------|-------------|");
  lines.push("| **Keep as skill** | Full content every turn | Essential for this project, needed constantly |");
  lines.push("| **Convert to rulebook rule** | Name + description only | Relevant but only needed on-demand (load via `rule://`) |");
  lines.push("| **Convert to TTSR rule** | Zero | Behavioral enforcement — triggered by regex pattern in output stream |");
  lines.push("| **Convert to slash command** | Zero | Interactive workflow the user invokes explicitly |");
  lines.push("| **Disable** | Zero | Irrelevant to this project's tech stack |");
  lines.push("");
  lines.push("For each skill, consider:");
  lines.push("1. Is it relevant to the detected tech stack? If not → **disable**.");
  lines.push("2. Does it enforce a behavior pattern (debugging, TDD, verification)? → **TTSR** with a condition regex.");
  lines.push("3. Is it reference material loaded for occasional lookups? → **rulebook** with a short description.");
  lines.push("4. Is it an interactive workflow the user triggers explicitly? → **slash command**.");
  lines.push("5. Is it essential context needed on every turn for this project? → **keep**.");
  lines.push("");
  lines.push("## Implementation");
  lines.push("");
  lines.push("After classifying, implement the changes:");
  lines.push("");
  lines.push("- **Rulebook**: Create `.omp/rules/<skill-name>.md` with YAML frontmatter `description: \"...\"` and condensed key content");
  lines.push("- **TTSR**: Create `.omp/rules/<skill-name>.md` with YAML frontmatter `condition: \"regex_pattern\"`");
  lines.push("- **Disable**: Note which skills to remove from the session configuration");
  lines.push("- **Command**: Note which skills could become slash commands (but don't create them now)");
  lines.push("");
  lines.push("## Warnings");
  lines.push("");
  lines.push("- Do **NOT** delete files from `~/.omp/skills/` — only create project-local `.omp/rules/` files");
  lines.push("- Rulebook and TTSR files go in `.omp/rules/` at the project root");
  lines.push("- Preserve the original skill content's intent when condensing for rulebook rules");
  lines.push("");
  lines.push("Present your classification table and implementation plan first, then ask before executing.");

  return lines.join("\n");
}
