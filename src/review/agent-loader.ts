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
import { resolvePackageManager } from "../workspace/package-manager.js";
import {
  getRootStateDir,
  getWorkspaceStateDir,
} from "../workspace/state-paths.js";
import { discoverWorkspaceTargets } from "../workspace/targets.js";
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
  { name: "security", enabled: true, data: "security.md", model: null, thinkingLevel: "low" },
  { name: "correctness", enabled: true, data: "correctness.md", model: null, thinkingLevel: "low" },
  { name: "maintainability", enabled: true, data: "maintainability.md", model: null, thinkingLevel: "low" },
];

export interface LoadedReviewAgents {
  agentsDir: string;
  configPath: string;
  config: ReviewAgentsConfig;
  agents: ConfiguredReviewAgent[];
}

export interface ReviewAgentLoadOptions {
  repoRoot?: string;
  workspaceRelativeDir?: string | null;
}

export interface ResolvedReviewAgentContext {
  repoRoot: string;
  workspaceRelativeDir: string | null;
}

const CONFIG_HEADER = [
  "# Review Agents Configuration",
  "#",
  "# Options:",
  "#   name:          string   - agent identifier (kebab-case)",
  "#   enabled:       boolean  - true | false",
  "#   data:          string   - markdown file name in the agents directory",
  "#   model:         string   - model id (e.g. \"anthropic/claude-sonnet-4-20250514\") or null to inherit",
  "#   thinkingLevel: string   - off | minimal | low | medium | high | xhigh | null to inherit",
  "#",
].join("\n");

function serializeConfigYaml(agents: ReviewAgentConfig[]): string {
  return [
    CONFIG_HEADER,
    "",
    "agents:",
    ...agents.flatMap((a, i) => [
      ...(i > 0 ? [""] : []),
      `  - name: ${a.name}`,
      `    enabled: ${a.enabled}`,
      `    data: ${a.data}`,
      `    model: ${a.model ?? "null"}`,
      `    thinkingLevel: ${a.thinkingLevel ?? "null"}`,
    ]),
    "",
  ].join("\n");
}

function buildDefaultConfigText(): string {
  return serializeConfigYaml(DEFAULT_REVIEW_AGENTS_CONFIG);
}

function writeIfMissing(filePath: string, content: string): void {
  if (fs.existsSync(filePath)) {
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

/**
 * Migrate pre-existing config.yml files:
 *  - adds the comment header if missing
 *  - backfills thinkingLevel on agents that lack it
 */
function migrateConfigIfNeeded(configPath: string): void {
  if (!fs.existsSync(configPath)) return;

  const raw = fs.readFileSync(configPath, "utf-8");
  if (raw.startsWith("# Review Agents Configuration")) return;

  // Parse the bare YAML by hand — we only need name/enabled/data/model/thinkingLevel.
  // The file is small and always has the same shape.
  const agents: ReviewAgentConfig[] = [];
  let current: Partial<ReviewAgentConfig> | null = null;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- name:")) {
      if (current?.name) agents.push(current as ReviewAgentConfig);
      current = { name: trimmed.slice("- name:".length).trim() };
    } else if (current && trimmed.startsWith("enabled:")) {
      current.enabled = trimmed.slice("enabled:".length).trim() === "true";
    } else if (current && trimmed.startsWith("data:")) {
      current.data = trimmed.slice("data:".length).trim();
    } else if (current && trimmed.startsWith("model:")) {
      const val = trimmed.slice("model:".length).trim();
      current.model = val === "null" ? null : val;
    } else if (current && trimmed.startsWith("thinkingLevel:")) {
      const val = trimmed.slice("thinkingLevel:".length).trim();
      current.thinkingLevel = val === "null" ? null : (val as any);
    }
  }
  if (current?.name) agents.push(current as ReviewAgentConfig);

  // Backfill thinkingLevel for agents that didn't have it
  for (const agent of agents) {
    if (agent.thinkingLevel === undefined) {
      agent.thinkingLevel = null;
    }
  }

  fs.writeFileSync(configPath, serializeConfigYaml(agents));
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

export function getRootReviewAgentsDir(paths: PlatformPaths, repoRoot: string): string {
  return path.join(getRootStateDir(paths, repoRoot), REVIEW_AGENTS_DIR);
}

export function getRootReviewAgentsConfigPath(paths: PlatformPaths, repoRoot: string): string {
  return path.join(getRootReviewAgentsDir(paths, repoRoot), CONFIG_FILE);
}

export function getWorkspaceReviewAgentsDir(
  paths: PlatformPaths,
  repoRoot: string,
  workspaceRelativeDir: string,
): string {
  return path.join(getWorkspaceStateDir(paths, repoRoot, workspaceRelativeDir), REVIEW_AGENTS_DIR);
}

export function getWorkspaceReviewAgentsConfigPath(
  paths: PlatformPaths,
  repoRoot: string,
  workspaceRelativeDir: string,
): string {
  return path.join(getWorkspaceReviewAgentsDir(paths, repoRoot, workspaceRelativeDir), CONFIG_FILE);
}

function hasWorkspaceManifest(repoRoot: string): boolean {
  if (fs.existsSync(path.join(repoRoot, "pnpm-workspace.yaml"))) {
    return true;
  }

  const manifestPath = path.join(repoRoot, "package.json");
  if (!fs.existsSync(manifestPath)) {
    return false;
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as {
      workspaces?: unknown;
    };
    if (Array.isArray(manifest.workspaces)) {
      return manifest.workspaces.some((entry) => typeof entry === "string" && entry.length > 0);
    }

    const workspaces = manifest.workspaces;
    if (!workspaces || typeof workspaces !== "object" || Array.isArray(workspaces)) {
      return false;
    }

    const packages = (workspaces as { packages?: unknown }).packages;
    return Array.isArray(packages) && packages.some((entry) => typeof entry === "string" && entry.length > 0);
  } catch {
    return false;
  }
}

function resolveRepoRoot(cwd: string): string {
  let current = path.resolve(cwd);
  let packageRoot: string | null = null;

  while (true) {
    if (fs.existsSync(path.join(current, "package.json"))) {
      packageRoot ??= current;
      if (hasWorkspaceManifest(current)) {
        return current;
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return packageRoot ?? path.resolve(cwd);
    }
    current = parent;
  }
}

export function resolveReviewAgentContext(
  cwd: string,
  options?: ReviewAgentLoadOptions,
): ResolvedReviewAgentContext {
  const repoRoot = options?.repoRoot ?? resolveRepoRoot(cwd);
  const explicitWorkspaceRelativeDir = options?.workspaceRelativeDir;
  if (explicitWorkspaceRelativeDir !== undefined) {
    return {
      repoRoot,
      workspaceRelativeDir: explicitWorkspaceRelativeDir && explicitWorkspaceRelativeDir !== "."
        ? explicitWorkspaceRelativeDir
        : null,
    };
  }

  const packageManager = resolvePackageManager(repoRoot);
  const workspaceTarget = discoverWorkspaceTargets(repoRoot, packageManager.id)
    .filter((target) => cwd === target.packageDir || cwd.startsWith(`${target.packageDir}${path.sep}`))
    .sort((left, right) => right.packageDir.length - left.packageDir.length)[0];

  return {
    repoRoot,
    workspaceRelativeDir: workspaceTarget?.kind === "workspace" ? workspaceTarget.relativeDir : null,
  };
}

function loadAgentsFromConfig(
  config: ReviewAgentsConfig,
  lookupDirs: string[],
  missingScopeLabel: string,
  scope?: ConfiguredReviewAgent["scope"],
): ConfiguredReviewAgent[] {
  return config.agents
    .filter((agent) => agent.enabled)
    .map((agent) => {
      const filePath = lookupDirs
        .map((dir) => path.join(dir, agent.data))
        .find((candidatePath) => fs.existsSync(candidatePath));
      if (!filePath) {
        throw new Error(`Configured review agent file does not exist in ${missingScopeLabel}: ${agent.data}`);
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
        thinkingLevel: agent.thinkingLevel ?? null,
        ...(scope ? { scope } : {}),
      } satisfies ConfiguredReviewAgent;
    });
}

function mergeAgentLayers(
  lowerAgents: ConfiguredReviewAgent[],
  higherAgents: ConfiguredReviewAgent[],
  higherConfig: ReviewAgentsConfig,
): ConfiguredReviewAgent[] {
  const higherConfigNames = new Set(higherConfig.agents.map((agent) => agent.name));
  return [
    ...lowerAgents.filter((agent) => !higherConfigNames.has(agent.name)),
    ...higherAgents,
  ];
}

export function ensureDefaultReviewAgents(paths: PlatformPaths, cwd: string): void {
  const agentsDir = getReviewAgentsDir(paths, cwd);
  fs.mkdirSync(agentsDir, { recursive: true });

  // Default agent markdown files are installed globally only.
  writeIfMissing(getReviewAgentsConfigPath(paths, cwd), buildDefaultConfigText());
  migrateConfigIfNeeded(getReviewAgentsConfigPath(paths, cwd));
}

export async function loadReviewAgentsConfig(
  paths: PlatformPaths,
  cwd: string,
  options?: ReviewAgentLoadOptions,
): Promise<ReviewAgentsConfig> {
  const context = resolveReviewAgentContext(cwd, options);
  ensureGlobalDefaultReviewAgents(paths);
  ensureDefaultReviewAgents(paths, context.repoRoot);
  return validateReviewAgentsConfig(await importYamlFile(getRootReviewAgentsConfigPath(paths, context.repoRoot)));
}

export async function loadReviewAgents(
  paths: PlatformPaths,
  cwd: string,
  options?: ReviewAgentLoadOptions,
): Promise<LoadedReviewAgents> {
  const context = resolveReviewAgentContext(cwd, options);
  const agentsDir = getRootReviewAgentsDir(paths, context.repoRoot);
  const configPath = getRootReviewAgentsConfigPath(paths, context.repoRoot);
  const globalAgentsDir = getGlobalReviewAgentsDir(paths);
  const config = await loadReviewAgentsConfig(paths, cwd, context);
  const agents = loadAgentsFromConfig(config, [agentsDir, globalAgentsDir], "root or global scope");

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
  migrateConfigIfNeeded(getGlobalReviewAgentsConfigPath(paths));
}

export async function loadGlobalReviewAgentsConfig(paths: PlatformPaths): Promise<ReviewAgentsConfig> {
  ensureGlobalDefaultReviewAgents(paths);
  return validateReviewAgentsConfig(await importYamlFile(getGlobalReviewAgentsConfigPath(paths)));
}

export async function loadGlobalReviewAgents(paths: PlatformPaths): Promise<LoadedReviewAgents> {
  const agentsDir = getGlobalReviewAgentsDir(paths);
  const configPath = getGlobalReviewAgentsConfigPath(paths);
  const config = await loadGlobalReviewAgentsConfig(paths);
  const agents = loadAgentsFromConfig(config, [agentsDir], "global scope", "global");

  return {
    agentsDir,
    configPath,
    config,
    agents,
  };
}

async function loadWorkspaceReviewAgentsConfig(
  paths: PlatformPaths,
  cwd: string,
  options: ReviewAgentLoadOptions,
): Promise<ReviewAgentsConfig> {
  const context = resolveReviewAgentContext(cwd, options);
  if (!context.workspaceRelativeDir) {
    return { agents: [] };
  }

  const configPath = getWorkspaceReviewAgentsConfigPath(
    paths,
    context.repoRoot,
    context.workspaceRelativeDir,
  );
  if (!fs.existsSync(configPath)) {
    return { agents: [] };
  }

  migrateConfigIfNeeded(configPath);
  return validateReviewAgentsConfig(await importYamlFile(configPath));
}

async function loadWorkspaceReviewAgents(
  paths: PlatformPaths,
  cwd: string,
  options: ReviewAgentLoadOptions,
): Promise<LoadedReviewAgents | null> {
  const context = resolveReviewAgentContext(cwd, options);
  if (!context.workspaceRelativeDir) {
    return null;
  }

  const agentsDir = getWorkspaceReviewAgentsDir(paths, context.repoRoot, context.workspaceRelativeDir);
  const configPath = getWorkspaceReviewAgentsConfigPath(
    paths,
    context.repoRoot,
    context.workspaceRelativeDir,
  );
  const rootAgentsDir = getRootReviewAgentsDir(paths, context.repoRoot);
  const globalAgentsDir = getGlobalReviewAgentsDir(paths);
  const config = await loadWorkspaceReviewAgentsConfig(paths, cwd, context);
  const agents = loadAgentsFromConfig(
    config,
    [agentsDir, rootAgentsDir, globalAgentsDir],
    "workspace, root, or global scope",
    "workspace",
  );

  return {
    agentsDir,
    configPath,
    config,
    agents,
  };
}

// ── Merged Loading (Global + Root + Workspace) ───────────────

export async function loadMergedReviewAgents(
  paths: PlatformPaths,
  cwd: string,
  options?: ReviewAgentLoadOptions,
): Promise<LoadedReviewAgents> {
  const context = resolveReviewAgentContext(cwd, options);
  const globalResult = await loadGlobalReviewAgents(paths);
  const rootResult = await loadReviewAgents(paths, cwd, context);
  const rootAgents = rootResult.agents.map((agent) => ({ ...agent, scope: "root" as const }));
  const mergedRootAgents = mergeAgentLayers(globalResult.agents, rootAgents, rootResult.config);

  const workspaceResult = await loadWorkspaceReviewAgents(paths, cwd, context);
  if (!workspaceResult) {
    return {
      agentsDir: rootResult.agentsDir,
      configPath: rootResult.configPath,
      config: rootResult.config,
      agents: mergedRootAgents,
    };
  }

  return {
    agentsDir: workspaceResult.agentsDir,
    configPath: workspaceResult.configPath,
    config: workspaceResult.config,
    agents: mergeAgentLayers(mergedRootAgents, workspaceResult.agents, workspaceResult.config),
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

  fs.writeFileSync(configPath, serializeConfigYaml(config.agents));
}
