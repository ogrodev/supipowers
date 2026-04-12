import type { Platform } from "../platform/types.js";
import {
  loadMergedReviewAgents,
  writeAgentFile,
  addAgentToConfig,
  getReviewAgentsDir,
  getReviewAgentsConfigPath,
  getGlobalReviewAgentsDir,
  getGlobalReviewAgentsConfigPath,
} from "../review/agent-loader.js";
import { selectModelFromList } from "./model.js";
import type { ConfiguredReviewAgent } from "../types.js";
import creatingAgentsSkill from "../../skills/creating-supi-agents/SKILL.md" with { type: "text" };

// ── List View ──────────────────────────────────────────────────

function buildAgentDashboard(agents: ConfiguredReviewAgent[]): string {
  const nameCol = 18;
  const modelCol = 24;
  const scopeCol = 10;

  const lines: string[] = [
    "\n  Review Agents\n",
    `  ${"name".padEnd(nameCol)} ${"model".padEnd(modelCol)} ${"scope".padEnd(scopeCol)} focus`,
  ];

  for (const agent of agents) {
    const name = agent.name.padEnd(nameCol);
    const model = (agent.model ?? "—").padEnd(modelCol);
    const scope = (agent.scope ?? "project").padEnd(scopeCol);
    const focus = agent.focus
      ? agent.focus.length > 40
        ? agent.focus.slice(0, 37) + "..."
        : agent.focus
      : "—";
    lines.push(`  ${name} ${model} ${scope} ${focus}`);
  }

  const globalCount = agents.filter((a) => a.scope === "global").length;
  const projectCount = agents.filter((a) => a.scope === "project" || !a.scope).length;
  lines.push("");
  lines.push(`  ${agents.length} agent(s) (${projectCount} project, ${globalCount} global)`);
  lines.push("");

  return lines.join("\n");
}

// ── Create Flow ────────────────────────────────────────────────

const KEBAB_CASE_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export async function runAgentCreateFlow(platform: Platform, ctx: any): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Agent creation requires interactive mode", "warning");
    return;
  }

  // Step 1: Scope selection
  const scopeChoice = await ctx.ui.select("Where should this agent live?", [
    "This project",
    "Global",
  ], { helpText: "Select scope · Esc to cancel" });

  if (!scopeChoice) return;
  const scope: "global" | "project" = scopeChoice === "Global" ? "global" : "project";

  // Step 2: Agent name
  const nameInput = await ctx.ui.input("Agent name (kebab-case)", {
    helpText: "e.g. performance, api-design, accessibility",
  });

  if (!nameInput) return;
  const agentName = nameInput.trim().toLowerCase();

  if (!KEBAB_CASE_RE.test(agentName)) {
    ctx.ui.notify(`Invalid agent name "${agentName}" — must be kebab-case (e.g. "my-agent")`, "error");
    return;
  }

  // Check for name collision in target scope
  try {
    const existing = await loadMergedReviewAgents(platform.paths, ctx.cwd);
    const collision = existing.agents.find(
      (a) => a.name === agentName && (a.scope ?? "project") === scope,
    );
    if (collision) {
      ctx.ui.notify(`Agent "${agentName}" already exists in ${scope} scope`, "error");
      return;
    }
  } catch {
    // If loading fails (e.g., no project dir), we can continue
  }

  // Step 3: Model selection
  const modelInput = await selectModelFromList(ctx);
  // null means "inherit default" — that's fine

  // Step 4: Prompt source
  const promptChoice = await ctx.ui.select("Agent prompt", [
    "Send a prompt",
    "Create from zero",
  ], { helpText: "Choose how to provide the agent prompt" });

  if (!promptChoice) return;

  if (promptChoice === "Create from zero") {
    // Load the creating-supi-agents skill via steer
    loadSkillAndSteer(platform, ctx, scope, agentName, modelInput);
    return;
  }

  // "Send a prompt" path
  const promptBody = await ctx.ui.input("Paste your agent prompt", {
    helpText: "The instructions the agent follows when reviewing code",
  });

  if (!promptBody?.trim()) {
    ctx.ui.notify("Agent creation cancelled — empty prompt", "warning");
    return;
  }

  // Step 5: Save
  const agentsDir = scope === "global"
    ? getGlobalReviewAgentsDir(platform.paths)
    : getReviewAgentsDir(platform.paths, ctx.cwd);
  const configPath = scope === "global"
    ? getGlobalReviewAgentsConfigPath(platform.paths)
    : getReviewAgentsConfigPath(platform.paths, ctx.cwd);

  const fileName = writeAgentFile(agentsDir, agentName, {
    name: agentName,
    description: `${agentName} review agent`,
    focus: null,
  }, promptBody.trim());

  await addAgentToConfig(configPath, {
    name: agentName,
    enabled: true,
    data: fileName,
    model: modelInput,
  });

  ctx.ui.notify(`Agent "${agentName}" created (${scope})`, "info");
}

// ── Skill Integration (steer pattern) ──────────────────────────

function loadSkillAndSteer(
  platform: Platform,
  ctx: any,
  scope: "global" | "project",
  agentName: string,
  model: string | null,
): void {
  const agentsDir = scope === "global"
    ? getGlobalReviewAgentsDir(platform.paths)
    : getReviewAgentsDir(platform.paths, ctx.cwd);
  const configPath = scope === "global"
    ? getGlobalReviewAgentsConfigPath(platform.paths)
    : getReviewAgentsConfigPath(platform.paths, ctx.cwd);

  const prompt = buildSkillSteerPrompt(agentName, scope, agentsDir, configPath, model);

  platform.sendMessage(
    {
      customType: "supi-agents-create",
      content: [{ type: "text", text: prompt }],
      display: "none",
    },
    { deliverAs: "steer", triggerTurn: true },
  );
}

function buildSkillSteerPrompt(
  agentName: string,
  scope: "global" | "project",
  agentsDir: string,
  configPath: string,
  model: string | null,
): string {
  return `You are guiding the user through creating a new AI review agent for supipowers' multi-agent code review pipeline.

## Agent Details (already collected)
- **Name**: ${agentName}
- **Scope**: ${scope}
- **Model**: ${model ?? "inherit default"}
- **Target directory**: ${agentsDir}
- **Config path**: ${configPath}

## Skill Instructions

${creatingAgentsSkill}

## Save Instructions

Once the user approves the agent design, save it:
1. Write the markdown file to: ${agentsDir}/${agentName}.md
   - The file MUST have YAML frontmatter (name, description, focus) and a prompt body ending with {output_instructions}
2. Update config at: ${configPath}
   - Add entry: { name: "${agentName}", enabled: true, data: "${agentName}.md", model: ${model ? `"${model}"` : "null"} }

Use the \`writeAgentFile\` and \`addAgentToConfig\` functions from \`src/review/agent-loader.ts\` if you have tool access, or write the files directly.

Start by asking the user about the goal/focus of their "${agentName}" agent.`;
}

// ── Command Entry Point ────────────────────────────────────────

export function handleAgents(platform: Platform, ctx: any, args?: string): void {
  if (args?.trim() === "create") {
    runAgentCreateFlow(platform, ctx).catch((err: Error) => {
      ctx.ui.notify(`Agent creation error: ${err.message}`, "error");
    });
    return;
  }

  // Solo invocation: show dashboard
  showAgentsDashboard(platform, ctx).catch((err: Error) => {
    ctx.ui.notify(`Error loading agents: ${err.message}`, "error");
  });
}

async function showAgentsDashboard(platform: Platform, ctx: any): Promise<void> {
  const result = await loadMergedReviewAgents(platform.paths, ctx.cwd);
  const dashboard = buildAgentDashboard(result.agents);
  ctx.ui.notify(dashboard, "info");
}

// ── Registration ───────────────────────────────────────────────

const SUBCOMMANDS = [
  { name: "create", description: "Create a new review agent" },
] as const;

export function registerAgentsCommand(platform: Platform): void {
  platform.registerCommand("supi:agents", {
    description: "List and manage review agents",
    getArgumentCompletions(prefix: string) {
      const lower = prefix.toLowerCase();
      const matches = SUBCOMMANDS
        .filter((s) => s.name.startsWith(lower))
        .map((s) => ({ value: `${s.name} `, label: s.name, description: s.description }));
      return matches.length > 0 ? matches : null;
    },
    async handler(args: string | undefined, ctx: any) {
      handleAgents(platform, ctx, args);
    },
  });
}
