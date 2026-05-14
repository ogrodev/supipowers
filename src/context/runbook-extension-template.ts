export const RUNBOOK_EXTENSION_NAME = "supipowers-runbook";
export const RUNBOOK_EXTENSION_PATH = ".omp/extensions/supipowers-runbook.ts";

export const RUNBOOK_EXTENSION_SOURCE = `import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";

type RuleBucket = "ttsr" | "always" | "rulebook" | "inactive";

interface RuleInfo {
  name: string;
  description: string | null;
  condition: string[];
  triggers: string[];
  scope: string[];
  alwaysApply: boolean;
  source: string;
  bucket: RuleBucket;
}

function decodeScalar(raw: string): string {
  const value = raw.trim();
  if (value.length === 0) return "";
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, value.endsWith('"') ? -1 : undefined);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
}

function parseFrontmatter(text: string): { metadata: Record<string, string | string[]>; body: string } {
  if (!text.startsWith("---\n")) return { metadata: {}, body: text.trim() };
  const close = text.indexOf("\n---", 4);
  if (close === -1) return { metadata: {}, body: text.trim() };
  const raw = text.slice(4, close);
  const bodyStart = text.indexOf("\n", close + 4);
  const body = bodyStart === -1 ? "" : text.slice(bodyStart + 1).trim();
  const metadata: Record<string, string | string[]> = {};
  let currentKey: string | null = null;

  for (const line of raw.split(/\r?\n/)) {
    const keyMatch = /^(\\w+):\\s*(.*)$/.exec(line);
    if (keyMatch) {
      currentKey = keyMatch[1];
      const value = keyMatch[2].trim();
      metadata[currentKey] = value.length === 0 ? [] : decodeScalar(value);
      continue;
    }
    const listMatch = /^\\s*-\\s*(.*)$/.exec(line);
    if (listMatch && currentKey) {
      const existing = metadata[currentKey];
      const values = Array.isArray(existing) ? existing : existing ? [existing] : [];
      values.push(decodeScalar(listMatch[1]));
      metadata[currentKey] = values;
    }
  }

  return { metadata, body };
}

function asList(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (!value) return [];
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function nameFromPath(filePath: string): string {
  const base = basename(filePath);
  const ext = extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

function bucket(rule: Pick<RuleInfo, "condition" | "alwaysApply" | "description">): RuleBucket {
  if (rule.condition.length > 0) return "ttsr";
  if (rule.alwaysApply) return "always";
  if (rule.description) return "rulebook";
  return "inactive";
}

function discoverRules(cwd: string): RuleInfo[] {
  const dir = join(cwd, ".omp", "rules");
  if (!existsSync(dir)) return [];
  const rules: RuleInfo[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const filePath = join(dir, entry);
    if (![".md", ".mdc"].includes(extname(filePath))) continue;
    try {
      if (!statSync(filePath).isFile()) continue;
      const parsed = parseFrontmatter(readFileSync(filePath, "utf8"));
      const info: RuleInfo = {
        name: nameFromPath(filePath),
        description: typeof parsed.metadata.description === "string" ? parsed.metadata.description : null,
        condition: asList(parsed.metadata.condition),
        triggers: asList(parsed.metadata.triggers ?? parsed.metadata.triggerDescription),
        scope: asList(parsed.metadata.scope),
        alwaysApply: parsed.metadata.alwaysApply === "true",
        source: filePath,
        bucket: "inactive",
      };
      info.bucket = bucket(info);
      rules.push(info);
    } catch {
      // Keep runbook display best-effort; unreadable rules should not break the command.
    }
  }
  return rules;
}

function describeScope(rule: RuleInfo): string {
  if (rule.scope.length === 0) return "assistant prose and tool-call text";
  const labels = rule.scope.map((scope) => {
    const normalized = scope.toLowerCase();
    if (normalized === "text") return "assistant prose";
    if (normalized === "thinking") return "assistant thinking";
    if (normalized === "tool" || normalized === "toolcall") return "all tool-call text";
    return "tool scope " + scope;
  });
  return labels.join(", ") + " only";
}

function formatRule(rule: RuleInfo): string[] {
  const lines = ["  " + rule.name];
  if (rule.description) lines.push("    Description: " + rule.description);
  if (rule.bucket === "ttsr") {
    lines.push("    Applies: when assistant output matches the trigger phrase(s)");
    if (rule.triggers.length > 0) {
      lines.push("    Triggers: " + rule.triggers.join(", "));
    } else {
      lines.push("    Triggers: exact regex only; add triggers: frontmatter for readability");
      for (const condition of rule.condition) lines.push("      - " + condition);
    }
    lines.push("    Scope: " + describeScope(rule));
  } else if (rule.bucket === "always") {
    lines.push("    Applies: always injected at session start");
  } else if (rule.bucket === "rulebook") {
    lines.push("    Applies: on demand via rule://" + rule.name);
  } else {
    lines.push("    Applies: inactive in prompt surfaces");
  }
  return lines;
}

function formatRules(cwd: string, onlyTtsr: boolean): string {
  const rules = discoverRules(cwd).filter((rule) => !onlyTtsr || rule.bucket === "ttsr");
  const lines = [onlyTtsr ? "/runbook rules ttsr" : "/runbook rules", "", "Rules: " + rules.length, ""];
  if (rules.length === 0) return [...lines, "  none"].join("\\n");
  for (const rule of rules.sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(...formatRule(rule), "");
  }
  return lines.join("\\n").trimEnd();
}

function formatCommands(api: any): string {
  const commands = typeof api.getCommands === "function" ? api.getCommands() : [];
  const lines = ["/runbook commands", "", "Registered slash commands: " + commands.length, ""];
  for (const command of [...commands].sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)))) {
    lines.push("  /" + command.name, "    " + (command.description ?? "No description"));
  }
  return lines.join("\\n");
}

function buildReport(api: any, cwd: string, args?: string): string {
  const tokens = (args ?? "").trim().split(/\\s+/).filter(Boolean).map((token) => token.toLowerCase());
  if (tokens[0] === "commands" || tokens[1] === "commands") return formatCommands(api);
  if (tokens[0] === "ttsr" || tokens[1] === "ttsr") return formatRules(cwd, true);
  return formatRules(cwd, false);
}

export default function supipowersRunbook(api: any): void {
  const handle = (args: string | undefined, ctx: any): void => {
    if (!ctx?.hasUI || !ctx.ui?.notify) return;
    ctx.ui.notify(buildReport(api, ctx.cwd ?? process.cwd(), args), "info");
  };

  api.registerCommand?.("runbook", {
    description: "Show project rules, TTSR triggers, and slash commands without an LLM turn",
    async handler(args: string | undefined, ctx: any): Promise<void> {
      handle(args, ctx);
    },
  });

  api.on?.("input", (event: any, ctx: any) => {
    const text = String(event?.text ?? "").trim();
    if (!text.startsWith("/runbook")) return;
    const args = text.length > "/runbook".length ? text.slice("/runbook".length).trim() : undefined;
    handle(args, ctx);
    return { handled: true };
  });
}
`;
