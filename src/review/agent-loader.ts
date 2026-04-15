import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import correctnessAgentTemplate from "./default-agents/correctness.md" with { type: "text" };
import maintainabilityAgentTemplate from "./default-agents/maintainability.md" with { type: "text" };
import securityAgentTemplate from "./default-agents/security.md" with { type: "text" };
import type { PlatformPaths } from "../platform/types.js";
import type {
  ConfiguredReviewAgent,
  ReviewAgentConfig,
  ReviewAgentDefinition,
  ReviewAgentsConfig,
} from "../types.js";
import { normalizeLineEndings } from "../text.js";
import {
  ReviewAgentFrontmatterSchema,
  ReviewAgentsConfigSchema,
  collectReviewValidationErrors,
  formatReviewValidationErrors,
} from "./types.js";

const REVIEW_AGENTS_DIR = "review-agents";
const CONFIG_FILE = "config.yml";

const DEFAULT_AGENT_TEMPLATES: Record<string, string> = {
  "security.md": securityAgentTemplate,
  "correctness.md": correctnessAgentTemplate,
  "maintainability.md": maintainabilityAgentTemplate,
};

const DEFAULT_REVIEW_AGENTS_CONFIG: ReviewAgentConfig[] = [
  { name: "security", enabled: true, data: "security.md", model: null },
  { name: "correctness", enabled: true, data: "correctness.md", model: null },
  { name: "maintainability", enabled: true, data: "maintainability.md", model: null },
];

export interface LoadedReviewAgents {
  agentsDir: string;
  configPath: string;
  config: ReviewAgentsConfig;
  agents: ConfiguredReviewAgent[];
}

function buildDefaultConfigText(): string {
  return [
    "agents:",
    ...DEFAULT_REVIEW_AGENTS_CONFIG.flatMap((agent) => [
      `  - name: ${agent.name}`,
      `    enabled: ${agent.enabled}`,
      `    data: ${agent.data}`,
      "    model: null",
    ]),
    "",
  ].join("\n");
}

function writeIfMissing(filePath: string, content: string): void {
  if (fs.existsSync(filePath)) {
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function validateReviewAgentsConfig(data: unknown): ReviewAgentsConfig {
  const errors = formatReviewValidationErrors(collectReviewValidationErrors(ReviewAgentsConfigSchema, data));
  if (errors.length > 0) {
    throw new Error(`Invalid review-agents config: ${errors.join("; ")}`);
  }
  return data as ReviewAgentsConfig;
}

async function importYamlFile(filePath: string): Promise<unknown> {
  const stat = fs.statSync(filePath);
  const url = pathToFileURL(filePath);
  const imported = await import(`${url.href}?mtime=${stat.mtimeMs}`, { with: { type: "yaml" } });
  return imported.default;
}

function parseFrontmatter(frontmatter: string, filePath: string): ReviewAgentDefinition {
  const metadata: Record<string, unknown> = {};

  for (const line of frontmatter.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const separator = trimmed.indexOf(":");
    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    metadata[key] = value;
  }

  const errors = formatReviewValidationErrors(
    collectReviewValidationErrors(ReviewAgentFrontmatterSchema, metadata),
  );
  if (errors.length > 0) {
    throw new Error(`Invalid agent frontmatter in ${filePath}: ${errors.join("; ")}`);
  }

  return {
    name: String(metadata.name),
    description: String(metadata.description),
    focus: typeof metadata.focus === "string" ? metadata.focus : null,
    prompt: "",
    filePath,
  };
}

export function parseReviewAgentMarkdown(content: string, filePath: string): ReviewAgentDefinition {
  const normalized = normalizeLineEndings(content);
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    throw new Error(`Review agent file ${filePath} is missing YAML frontmatter.`);
  }

  const definition = parseFrontmatter(match[1], filePath);
  const prompt = match[2]?.trim();
  if (!prompt) {
    throw new Error(`Review agent file ${filePath} has an empty prompt body.`);
  }

  return {
    ...definition,
    prompt,
  };
}

export function getReviewAgentsDir(paths: PlatformPaths, cwd: string): string {
  return paths.project(cwd, REVIEW_AGENTS_DIR);
}

export function getReviewAgentsConfigPath(paths: PlatformPaths, cwd: string): string {
  return path.join(getReviewAgentsDir(paths, cwd), CONFIG_FILE);
}

export function ensureDefaultReviewAgents(paths: PlatformPaths, cwd: string): void {
  const agentsDir = getReviewAgentsDir(paths, cwd);
  fs.mkdirSync(agentsDir, { recursive: true });

  // Default agent markdown files are installed globally only.
  writeIfMissing(getReviewAgentsConfigPath(paths, cwd), buildDefaultConfigText());
}

export async function loadReviewAgentsConfig(paths: PlatformPaths, cwd: string): Promise<ReviewAgentsConfig> {
  ensureGlobalDefaultReviewAgents(paths);
  ensureDefaultReviewAgents(paths, cwd);
  return validateReviewAgentsConfig(await importYamlFile(getReviewAgentsConfigPath(paths, cwd)));
}

export async function loadReviewAgents(paths: PlatformPaths, cwd: string): Promise<LoadedReviewAgents> {
  const agentsDir = getReviewAgentsDir(paths, cwd);
  const configPath = getReviewAgentsConfigPath(paths, cwd);
  const globalAgentsDir = getGlobalReviewAgentsDir(paths);
  const config = await loadReviewAgentsConfig(paths, cwd);

  const agents = config.agents
    .filter((agent) => agent.enabled)
    .map((agent) => {
      const projectFilePath = path.join(agentsDir, agent.data);
      const globalFilePath = path.join(globalAgentsDir, agent.data);
      const filePath = fs.existsSync(projectFilePath) ? projectFilePath : globalFilePath;
      if (!fs.existsSync(filePath)) {
        throw new Error(
          `Configured review agent file does not exist in project or global scope: ${agent.data}`
        );
      }

      const definition = parseReviewAgentMarkdown(fs.readFileSync(filePath, "utf-8"), filePath);
      if (definition.name !== agent.name) {
        throw new Error(
          `Configured agent name "${agent.name}" does not match frontmatter name "${definition.name}" in ${filePath}.`,
        );
      }

      return {
        ...definition,
        enabled: agent.enabled,
        data: agent.data,
        model: agent.model,
      } satisfies ConfiguredReviewAgent;
    });

  return {
    agentsDir,
    configPath,
    config,
    agents,
  };
}

// ── Global Agent Support ────────────────────────────────────

export function getGlobalReviewAgentsDir(paths: PlatformPaths): string {
  return paths.global(REVIEW_AGENTS_DIR);
}

export function getGlobalReviewAgentsConfigPath(paths: PlatformPaths): string {
  return path.join(getGlobalReviewAgentsDir(paths), CONFIG_FILE);
}

export function ensureGlobalDefaultReviewAgents(paths: PlatformPaths): void {
  const agentsDir = getGlobalReviewAgentsDir(paths);
  fs.mkdirSync(agentsDir, { recursive: true });

  for (const [fileName, content] of Object.entries(DEFAULT_AGENT_TEMPLATES)) {
    writeIfMissing(path.join(agentsDir, fileName), content);
  }

  writeIfMissing(getGlobalReviewAgentsConfigPath(paths), buildDefaultConfigText());
}

export async function loadGlobalReviewAgentsConfig(paths: PlatformPaths): Promise<ReviewAgentsConfig> {
  ensureGlobalDefaultReviewAgents(paths);
  return validateReviewAgentsConfig(await importYamlFile(getGlobalReviewAgentsConfigPath(paths)));
}

export async function loadGlobalReviewAgents(paths: PlatformPaths): Promise<LoadedReviewAgents> {
  const agentsDir = getGlobalReviewAgentsDir(paths);
  const configPath = getGlobalReviewAgentsConfigPath(paths);
  const config = await loadGlobalReviewAgentsConfig(paths);

  const agents = config.agents
    .filter((agent) => agent.enabled)
    .map((agent) => {
      const filePath = path.join(agentsDir, agent.data);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Configured review agent file does not exist: ${filePath}`);
      }

      const definition = parseReviewAgentMarkdown(fs.readFileSync(filePath, "utf-8"), filePath);
      if (definition.name !== agent.name) {
        throw new Error(
          `Configured agent name "${agent.name}" does not match frontmatter name "${definition.name}" in ${filePath}.`,
        );
      }

      return {
        ...definition,
        enabled: agent.enabled,
        data: agent.data,
        model: agent.model,
        scope: "global" as const,
      } satisfies ConfiguredReviewAgent;
    });

  return {
    agentsDir,
    configPath,
    config,
    agents,
  };
}

// ── Merged Loading (Global + Project) ──────────────────────

export async function loadMergedReviewAgents(
  paths: PlatformPaths,
  cwd: string,
): Promise<LoadedReviewAgents> {
  const globalResult = await loadGlobalReviewAgents(paths);
  const projectResult = await loadReviewAgents(paths, cwd);

  // Project config is authoritative: any agent named in the project config
  // (enabled or disabled) shadows the global version with the same name.
  const projectConfigNames = new Set(projectResult.config.agents.map((a) => a.name));
  const uniqueGlobalAgents = globalResult.agents.filter((a) => !projectConfigNames.has(a.name));

  // Tag project agents with scope
  const projectAgents = projectResult.agents.map((agent) => ({
    ...agent,
    scope: "project" as const,
  }));

  return {
    agentsDir: projectResult.agentsDir,
    configPath: projectResult.configPath,
    config: projectResult.config,
    agents: [...uniqueGlobalAgents, ...projectAgents],
  };
}

// ── Write Helpers ──────────────────────────────────────────

export function writeAgentFile(
  agentsDir: string,
  name: string,
  frontmatter: { name: string; description: string; focus: string | null },
  promptBody: string,
): string {
  const fileName = `${name}.md`;
  const filePath = path.join(agentsDir, fileName);
  const focusLine = frontmatter.focus ? `\nfocus: ${frontmatter.focus}` : "";
  const content = `---\nname: ${frontmatter.name}\ndescription: ${frontmatter.description}${focusLine}\n---\n\n${promptBody}\n`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return fileName;
}

export async function addAgentToConfig(
  configPath: string,
  agent: ReviewAgentConfig,
): Promise<void> {
  let config: ReviewAgentsConfig;
  try {
    config = validateReviewAgentsConfig(await importYamlFile(configPath));
  } catch {
    config = { agents: [] };
  }

  // Idempotent: replace if name exists, append otherwise
  const idx = config.agents.findIndex((a) => a.name === agent.name);
  if (idx >= 0) {
    config.agents[idx] = agent;
  } else {
    config.agents.push(agent);
  }

  const text = [
    "agents:",
    ...config.agents.flatMap((a) => [
      `  - name: ${a.name}`,
      `    enabled: ${a.enabled}`,
      `    data: ${a.data}`,
      `    model: ${a.model ?? "null"}`,
    ]),
    "",
  ].join("\n");
  fs.writeFileSync(configPath, text);
}
