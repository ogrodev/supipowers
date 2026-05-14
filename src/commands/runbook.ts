import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

import YAML from "yaml";

import type { Platform, PlatformContext, CommandInfo } from "../platform/types.js";

type RuleProvider = "native" | "cursor" | "windsurf" | "cline";
type RuleLevel = "project" | "user";
type RuleBucket = "ttsr" | "always" | "rulebook" | "inactive";
type RunbookMode = "rules" | "ttsr" | "commands" | "help";

interface RuleSource {
  provider: RuleProvider;
  level: RuleLevel;
  path: string;
  priority: number;
}

interface RuleCandidate {
  name: string;
  content: string;
  description: string | null;
  alwaysApply: boolean;
  globs: string[];
  condition: string[];
  triggers: string[];
  scope: string[];
  interruptMode: string | null;
  source: RuleSource;
}

export interface RegisteredRule extends RuleCandidate {
  bucket: RuleBucket;
  shadowedBy?: RuleSource;
}

export interface RuleDiscoveryResult {
  active: RegisteredRule[];
  shadowed: RegisteredRule[];
  checkedLocations: string[];
}

export interface RuleDiscoveryOptions {
  homeDir?: string;
  includeUserRules?: boolean;
}

interface FrontmatterResult {
  metadata: Record<string, unknown>;
  body: string;
}

const RULE_EXTENSIONS = new Set([".md", ".mdc"]);
const PROVIDER_PRIORITY: Record<RuleProvider, number> = {
  native: 100,
  cursor: 50,
  windsurf: 50,
  cline: 40,
};

function parseFrontmatter(content: string): FrontmatterResult {
  if (!content.startsWith("---\n")) {
    return { metadata: {}, body: content.trim() };
  }

  const closing = content.indexOf("\n---", 4);
  if (closing === -1) {
    return { metadata: {}, body: content.trim() };
  }

  const raw = content.slice(4, closing);
  const bodyStart = content.indexOf("\n", closing + 4);
  const body = bodyStart === -1 ? "" : content.slice(bodyStart + 1).trim();
  try {
    const parsed = YAML.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { metadata: parsed as Record<string, unknown>, body };
    }
  } catch {
    // Match OMP's permissive behavior: invalid YAML still leaves the rule loadable.
  }

  return { metadata: parseSimpleFrontmatter(raw), body };
}

function parseSimpleFrontmatter(raw: string): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = /^(\w+):\s*(.*)$/.exec(line);
    if (!match) continue;
    metadata[match[1]] = match[2];
  }
  return metadata;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function ruleNameFromPath(filePath: string, fallbackName?: string): string {
  if (fallbackName) return fallbackName;
  const base = basename(filePath);
  const ext = extname(base);
  return ext.length > 0 ? base.slice(0, -ext.length) : base;
}

function buildRuleCandidate(filePath: string, source: RuleSource, fallbackName?: string): RuleCandidate | null {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  const { metadata, body } = parseFrontmatter(content);
  const condition = asStringArray(
    metadata.condition ?? metadata.ttsr_trigger ?? metadata.ttsrTrigger,
  );

  return {
    name: ruleNameFromPath(filePath, fallbackName),
    content: body,
    description: asString(metadata.description),
    alwaysApply: asBoolean(metadata.alwaysApply),
    globs: asStringArray(metadata.globs),
    condition,
    scope: asStringArray(metadata.scope),
    triggers: asStringArray(metadata.triggers ?? metadata.triggerDescription),
    interruptMode: asString(metadata.interruptMode),
    source,
  };
}

function isRuleFile(filePath: string): boolean {
  return RULE_EXTENSIONS.has(extname(filePath));
}

function loadRuleDir(dirPath: string, source: Omit<RuleSource, "path">): RuleCandidate[] {
  if (!existsSync(dirPath)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dirPath).sort();
  } catch {
    return [];
  }

  const rules: RuleCandidate[] = [];
  for (const entry of entries) {
    const filePath = join(dirPath, entry);
    if (!isRuleFile(filePath)) continue;
    try {
      if (!statSync(filePath).isFile()) continue;
    } catch {
      continue;
    }
    const candidate = buildRuleCandidate(filePath, { ...source, path: filePath });
    if (candidate) rules.push(candidate);
  }
  return rules;
}

function loadSingleRule(filePath: string, source: Omit<RuleSource, "path">, fallbackName?: string): RuleCandidate[] {
  if (!existsSync(filePath)) return [];
  try {
    if (!statSync(filePath).isFile()) return [];
  } catch {
    return [];
  }
  const candidate = buildRuleCandidate(filePath, { ...source, path: filePath }, fallbackName);
  return candidate ? [candidate] : [];
}

function findNearestClineRules(cwd: string, home: string): string | null {
  let current = resolve(cwd);
  const homeResolved = resolve(home);
  while (true) {
    const candidate = join(current, ".clinerules");
    if (existsSync(candidate)) return candidate;
    if (current === homeResolved || dirname(current) === current) return null;
    current = dirname(current);
  }
}

function createSource(provider: RuleProvider, level: RuleLevel): Omit<RuleSource, "path"> {
  return { provider, level, priority: PROVIDER_PRIORITY[provider] };
}

function collectRuleCandidates(cwd: string, options: RuleDiscoveryOptions): { candidates: RuleCandidate[]; checked: string[] } {
  const home = options.homeDir ?? homedir();
  const includeUser = options.includeUserRules ?? true;
  const candidates: RuleCandidate[] = [];
  const checked: string[] = [];

  const nativeProject = join(cwd, ".omp", "rules");
  checked.push(nativeProject);
  candidates.push(...loadRuleDir(nativeProject, createSource("native", "project")));

  if (includeUser) {
    const nativeUser = join(home, ".omp", "agent", "rules");
    checked.push(nativeUser);
    candidates.push(...loadRuleDir(nativeUser, createSource("native", "user")));
  }

  if (includeUser) {
    const cursorUser = join(home, ".cursor", "rules");
    checked.push(cursorUser);
    candidates.push(...loadRuleDir(cursorUser, createSource("cursor", "user")));
  }
  const cursorProject = join(cwd, ".cursor", "rules");
  checked.push(cursorProject);
  candidates.push(...loadRuleDir(cursorProject, createSource("cursor", "project")));

  if (includeUser) {
    const windsurfUser = join(home, ".codeium", "windsurf", "memories", "global_rules.md");
    checked.push(windsurfUser);
    candidates.push(...loadSingleRule(windsurfUser, createSource("windsurf", "user"), "global_rules"));
  }
  const windsurfProject = join(cwd, ".windsurf", "rules");
  checked.push(windsurfProject);
  candidates.push(...loadRuleDir(windsurfProject, createSource("windsurf", "project")));

  const clineRules = findNearestClineRules(cwd, home);
  if (clineRules) {
    checked.push(clineRules);
    try {
      if (statSync(clineRules).isDirectory()) {
        candidates.push(...loadRuleDir(clineRules, createSource("cline", "project")));
      } else {
        candidates.push(...loadSingleRule(clineRules, createSource("cline", "project"), "clinerules"));
      }
    } catch {
      // Ignore unreadable Cline rule paths, matching discovery's best-effort behavior.
    }
  } else {
    checked.push(join(cwd, ".clinerules"));
  }

  return { candidates, checked };
}

function bucketForRule(rule: RuleCandidate): RuleBucket {
  if (rule.condition.length > 0) return "ttsr";
  if (rule.alwaysApply) return "always";
  if (rule.description) return "rulebook";
  return "inactive";
}

export function discoverRegisteredRules(cwd: string, options: RuleDiscoveryOptions = {}): RuleDiscoveryResult {
  const { candidates, checked } = collectRuleCandidates(cwd, options);
  const seen = new Map<string, RegisteredRule>();
  const active: RegisteredRule[] = [];
  const shadowed: RegisteredRule[] = [];

  for (const candidate of candidates) {
    const registered: RegisteredRule = { ...candidate, bucket: bucketForRule(candidate) };
    const existing = seen.get(candidate.name);
    if (existing) {
      shadowed.push({ ...registered, shadowedBy: existing.source });
      continue;
    }
    seen.set(candidate.name, registered);
    active.push(registered);
  }

  return { active, shadowed, checkedLocations: checked };
}

function displayPath(cwd: string, filePath: string): string {
  const absolute = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
  const home = homedir();
  if (absolute === home || absolute.startsWith(`${home}/`)) {
    return `~${absolute.slice(home.length)}`;
  }
  const rel = relative(cwd, absolute);
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
  return absolute;
}

function summarizeCounts(rules: RegisteredRule[]): string {
  const ttsr = rules.filter((rule) => rule.bucket === "ttsr").length;
  const rulebook = rules.filter((rule) => rule.bucket === "rulebook").length;
  const always = rules.filter((rule) => rule.bucket === "always").length;
  const inactive = rules.filter((rule) => rule.bucket === "inactive").length;
  return `${rules.length} registered (${ttsr} TTSR, ${rulebook} rulebook, ${always} always-apply, ${inactive} inactive)`;
}

function formatListValue(values: string[], empty: string): string[] {
  if (values.length === 0) return [`    ${empty}`];
  return values.map((value) => `    - ${value}`);
}

function formatInlineList(values: string[]): string {
  return values.join(", ");
}

function describeScope(rule: RegisteredRule): string {
  if (rule.scope.length === 0) return "assistant prose and tool-call text";
  const labels = rule.scope.map((scope) => {
    const normalized = scope.toLowerCase();
    if (normalized === "text") return "assistant prose";
    if (normalized === "thinking") return "assistant thinking";
    if (normalized === "tool" || normalized === "toolcall") return "all tool-call text";
    return `tool scope ${scope}`;
  });
  return `${formatInlineList(labels)} only`;
}

function formatTriggerSummary(rule: RegisteredRule): string[] {
  if (rule.triggers.length > 0) {
    return [`    Triggers: ${formatInlineList(rule.triggers)}`];
  }

  if (rule.condition.length === 0) return ["    Triggers: none"];
  return [
    "    Triggers: exact regex only; add `triggers:` frontmatter for a readable summary",
    "    Raw regex:",
    ...formatListValue(rule.condition, "none"),
  ];
}

function formatRule(rule: RegisteredRule, cwd: string): string[] {
  const lines = [`  ${rule.name}`];
  if (rule.description) lines.push(`    Description: ${rule.description}`);

  if (rule.bucket === "ttsr") {
    lines.push("    Applies: when assistant output matches the trigger phrase(s)");
    lines.push(...formatTriggerSummary(rule));
    lines.push(`    Scope: ${describeScope(rule)}`);
    lines.push(`    Interrupt: ${rule.interruptMode ?? "default"}`);
  } else if (rule.bucket === "always") {
    lines.push("    Applies: alwaysApply=true, full rule content is injected at session start");
  } else if (rule.bucket === "rulebook") {
    lines.push(`    Applies: on demand via rule://${rule.name} when the description/domain matches`);
  } else {
    lines.push("    Applies: inactive in OMP prompt surfaces (no description, condition, or alwaysApply)");
  }

  if (rule.globs.length > 0) {
    lines.push("    Globs:");
    lines.push(...formatListValue(rule.globs, "none"));
  }
  lines.push(`    Source: ${rule.source.provider}/${rule.source.level} ${displayPath(cwd, rule.source.path)}`);
  return lines;
}

function formatRuleSection(title: string, rules: RegisteredRule[], cwd: string): string[] {
  const lines = [title];
  if (rules.length === 0) {
    lines.push("  none");
    return lines;
  }
  for (const rule of rules) {
    lines.push(...formatRule(rule, cwd), "");
  }
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function formatShadowedRules(shadowed: RegisteredRule[], cwd: string): string[] {
  if (shadowed.length === 0) return [];
  const lines = ["", `Shadowed rules (${shadowed.length})`];
  for (const rule of shadowed) {
    const by = rule.shadowedBy;
    const source = by ? `${by.provider}/${by.level} ${displayPath(cwd, by.path)}` : "earlier rule";
    lines.push(`  ${rule.name}: ${displayPath(cwd, rule.source.path)} shadowed by ${source}`);
  }
  return lines;
}

export function formatRulesRunbook(discovery: RuleDiscoveryResult, cwd: string): string {
  const sorted = [...discovery.active].sort((a, b) => a.name.localeCompare(b.name));
  const ttsr = sorted.filter((rule) => rule.bucket === "ttsr");
  const always = sorted.filter((rule) => rule.bucket === "always");
  const rulebook = sorted.filter((rule) => rule.bucket === "rulebook");
  const inactive = sorted.filter((rule) => rule.bucket === "inactive");
  const lines = [
    "/runbook rules",
    "",
    `Rules: ${summarizeCounts(sorted)}`,
    "",
    "Usage:",
    "  /runbook rules          Show all registered rules",
    "  /runbook rules ttsr     Show only TTSR stream-interrupt rules",
    "  /runbook commands       Show registered slash commands",
    "",
    ...formatRuleSection("TTSR rules", ttsr, cwd),
    "",
    ...formatRuleSection("Always-apply rules", always, cwd),
    "",
    ...formatRuleSection("Rulebook rules", rulebook, cwd),
  ];
  if (inactive.length > 0) {
    lines.push("", ...formatRuleSection("Inactive discovered rules", inactive, cwd));
  }
  lines.push(...formatShadowedRules(discovery.shadowed, cwd));
  return lines.join("\n");
}

export function formatTtsrRunbook(discovery: RuleDiscoveryResult, cwd: string): string {
  const ttsr = discovery.active
    .filter((rule) => rule.bucket === "ttsr")
    .sort((a, b) => a.name.localeCompare(b.name));
  const lines = [
    "/runbook rules ttsr",
    "",
    `TTSR rules: ${ttsr.length}`,
    "",
    "These rules are registered at session creation and monitor assistant output. When a condition matches, OMP injects the rule reminder without requiring a user prompt.",
    "",
    ...formatRuleSection("TTSR rules", ttsr, cwd),
  ];
  return lines.join("\n");
}

export function formatCommandsRunbook(commands: CommandInfo[]): string {
  const sorted = [...commands].sort((a, b) => a.name.localeCompare(b.name));
  const lines = [
    "/runbook commands",
    "",
    `Registered slash commands: ${sorted.length}`,
    "",
  ];
  if (sorted.length === 0) {
    lines.push("  none");
    return lines.join("\n");
  }
  for (const command of sorted) {
    const description = command.description ?? "No description";
    const source = command.source ? ` (${command.source})` : "";
    lines.push(`  /${command.name}${source}`);
    lines.push(`    ${description}`);
  }
  return lines.join("\n");
}

export function parseRunbookMode(args: string | undefined): RunbookMode {
  const tokens = (args ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.toLowerCase());

  if (tokens.length === 0) return "rules";
  if (tokens[0] === "rules") {
    if (tokens.length === 1) return "rules";
    if (tokens[1] === "ttsr" || tokens[1] === "--ttsr") return "ttsr";
    if (tokens[1] === "commands" || tokens[1] === "--commands") return "commands";
    return "help";
  }
  if (tokens[0] === "ttsr" || tokens[0] === "--ttsr") return "ttsr";
  if (tokens[0] === "commands" || tokens[0] === "--commands") return "commands";
  if (tokens[0] === "help" || tokens[0] === "--help" || tokens[0] === "-h") return "help";
  return "help";
}

function formatRunbookHelp(): string {
  return [
    "/runbook",
    "",
    "Usage:",
    "  /runbook rules          Show all registered OMP rules",
    "  /runbook rules ttsr     Show TTSR rule conditions",
    "  /runbook ttsr           Alias for /runbook rules ttsr",
    "  /runbook commands       Show registered slash commands",
    "",
    "This command is read-only and never starts an LLM turn.",
  ].join("\n");
}

export function buildRunbookReport(platform: Platform, cwd: string, args: string | undefined): string {
  const mode = parseRunbookMode(args);
  if (mode === "help") return formatRunbookHelp();
  if (mode === "commands") return formatCommandsRunbook(platform.getCommands());

  const discovery = discoverRegisteredRules(cwd);
  return mode === "ttsr" ? formatTtsrRunbook(discovery, cwd) : formatRulesRunbook(discovery, cwd);
}

export function handleRunbook(platform: Platform, ctx: PlatformContext, args?: string): void {
  if (!ctx.hasUI) return;
  try {
    ctx.ui.notify(buildRunbookReport(platform, ctx.cwd, args), "info");
  } catch (error) {
    ctx.ui.notify(`Runbook failed: ${(error as Error).message}`, "error");
  }
}

export function registerRunbookCommand(platform: Platform): void {
  platform.registerCommand("runbook", {
    description: "Show registered OMP rules, TTSR conditions, and slash commands without an LLM turn",
    async handler(args: string | undefined, ctx: PlatformContext): Promise<void> {
      handleRunbook(platform, ctx, args);
    },
  });
}
