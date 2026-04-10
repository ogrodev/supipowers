import type { Platform, PlatformContext } from "../platform/types.js";
import {
  parseSystemPrompt,
  parseIndividualSkills,
} from "../context/analyzer.js";
import {
  detectTechStack,
  buildContextReport,
} from "../context/optimizer.js";
import type { ContextReport } from "../context/optimizer.js";

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

export function handleOptimizeContext(platform: Platform, ctx: PlatformContext): void {
  void (async () => {
    if (!ctx.hasUI) return;

    // 1. Detect tech stack
    const techStack = await detectTechStack(platform, ctx.cwd);

    // 2. Get system prompt
    let systemPrompt = "";
    try {
      systemPrompt = (ctx as any).getSystemPrompt?.() ?? "";
    } catch {
      // getSystemPrompt not available
    }

    if (!systemPrompt) {
      ctx.ui.notify("System prompt unavailable", "warning");
      return;
    }

    // 3. Parse
    const sections = parseSystemPrompt(systemPrompt);
    const skills = parseIndividualSkills(systemPrompt);

    // 4. Build raw report
    const report = buildContextReport(sections, skills, techStack);

    // 5. Show TUI
    await showReport(platform, ctx, report);
  })().catch((err) => {
    ctx.ui.notify(`Optimize error: ${(err as Error).message}`, "error");
  });
}

export function registerOptimizeContextCommand(platform: Platform): void {
  platform.registerCommand("supi:optimize-context", {
    description: "Analyze context usage and suggest token optimizations",
    async handler(_args: string | undefined, ctx: any) {
      handleOptimizeContext(platform, ctx);
    },
  });
}

// ── Internal ──────────────────────────────────────────────

async function showReport(
  platform: Platform,
  ctx: PlatformContext,
  report: ContextReport,
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

  // Skills breakdown
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

  // Non-skill sections
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

  // confirm() may not be available on all platforms
  const shouldOptimize = ctx.ui.confirm
    ? await ctx.ui.confirm("Context Optimization", message)
    : (await ctx.ui.select("Context Optimization", [message, "▶ Optimize with AI", "Close"]))?.includes("Optimize");

  if (!shouldOptimize) return;

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

  // Skill inventory
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

  // Section inventory
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
