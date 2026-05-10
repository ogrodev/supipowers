import { basename } from "node:path";

/** Estimate token count from text using chars/4 heuristic */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

/** Format byte count as human-readable KB */
export function formatSize(bytes: number): string {
  if (bytes === 0) return "0KB";
  const kb = bytes / 1024;
  if (kb < 10) return `${kb.toFixed(1)}KB`;
  return `${Math.round(kb)}KB`;
}

// ── System Prompt Parser ──────────────────────────────────

/** A parsed section of the system prompt */
export interface PromptSection {
  label: string;
  bytes: number;
  content: string;
}

/** Parse a system prompt into labeled sections */
export function parseSystemPrompt(text: string): PromptSection[] {
  if (!text) return [];

  const sections: PromptSection[] = [];
  const consumed = new Set<number>();

  // 1. Extract XML-like sections
  extractXmlSections(text, sections, consumed);

  // 2. Extract heading-based sections
  extractHeadingSections(text, sections, consumed);

  // 3. Collect remaining text as "Base system prompt"
  const base = collectUnconsumed(text, consumed);
  if (base.trim().length > 0) {
    sections.push({ label: "Base system prompt", bytes: byteLength(base), content: base });
  }

  return sections;
}

// ── Per-Skill Parser ──────────────────────────────────────

/** A single skill extracted from the system prompt */
export interface ParsedSkill {
  name: string;
  bytes: number;
  tokens: number;
  content: string;
}

/** Extract individual skills from system prompt text */
export function parseIndividualSkills(systemPrompt: string): ParsedSkill[] {
  if (!systemPrompt) return [];

  // Locate `# Skills` and bound the section by the next h1 heading or end of
  // text. The legacy bound used `^##\s`, which let the section bleed past
  // sibling h2 headings (e.g. `## MCP Server Instructions`) into unrelated
  // content and misidentify them as skills.
  const headerMatch = systemPrompt.match(/^# Skills\b[^\n]*\n/m);
  if (!headerMatch) return [];
  const bodyStart = headerMatch.index! + headerMatch[0].length;
  const after = systemPrompt.slice(bodyStart);
  const nextH1 = after.search(/^# [^#]/m);
  const skillsBody = nextH1 === -1 ? after : after.slice(0, nextH1);

  // Modern OMP (≥14.7) renders skills as a bullet list: "- name: description"
  // with descriptions that may wrap across multiple lines.
  const bulletRegex = /^- ([a-zA-Z0-9._-]+):/gm;
  const bullets: { name: string; index: number }[] = [];
  let bm: RegExpExecArray | null;
  while ((bm = bulletRegex.exec(skillsBody)) !== null) {
    bullets.push({ name: bm[1], index: bm.index });
  }

  if (bullets.length > 0) {
    // Defensive upper bound for the last bullet: stop at any inline markdown
    // heading inside the body. Real OMP prompts already terminate at an h1
    // boundary, but synthetic / older prompts may not.
    let bodyEnd = skillsBody.length;
    const headingScan = /^#{1,6}\s/gm;
    let hsm: RegExpExecArray | null;
    while ((hsm = headingScan.exec(skillsBody)) !== null) {
      if (hsm.index > bullets[bullets.length - 1].index) {
        bodyEnd = hsm.index;
        break;
      }
    }

    const bulletSkills: ParsedSkill[] = [];
    for (let i = 0; i < bullets.length; i++) {
      const start = bullets[i].index;
      const end = i + 1 < bullets.length ? bullets[i + 1].index : bodyEnd;
      const content = skillsBody.slice(start, end).trimEnd();
      bulletSkills.push({
        name: bullets[i].name,
        bytes: byteLength(content),
        tokens: estimateTokens(content),
        content,
      });
    }
    return bulletSkills;
  }

  // Legacy / synthetic shape: "## name" h2 sub-headings under `# Skills`.
  const headingRegex = /^## (.+)$/gm;
  const headings: { name: string; index: number }[] = [];
  let hm: RegExpExecArray | null;
  while ((hm = headingRegex.exec(skillsBody)) !== null) {
    headings.push({ name: hm[1].trim(), index: hm.index });
  }

  const skills: ParsedSkill[] = [];
  for (let i = 0; i < headings.length; i++) {
    const start = headings[i].index;
    const end = i + 1 < headings.length ? headings[i + 1].index : skillsBody.length;
    const content = skillsBody.slice(start, end).trimEnd();
    skills.push({
      name: headings[i].name,
      bytes: byteLength(content),
      tokens: estimateTokens(content),
      content,
    });
  }

  return skills;
}

// ── Breakdown Builder ─────────────────────────────────────

/** Context usage data from OMP runtime */
export interface ContextUsage {
  tokens: number | null;
  contextWindow: number | null;
  percent: number | null;
}


/** A breakdown line with optional drillable data */
export interface BreakdownItem {
  line: string;
  section?: PromptSection;
  toolNames?: string[];
}
/** Format a token count as human-readable (e.g., 50000 → "50K") */
function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

/** Build display lines for the TUI breakdown */
export function buildBreakdown(
  usage: ContextUsage | null,
  sections: PromptSection[],
  activeTools: string[],
  noSystemPrompt = false,
): string[] {
  return buildBreakdownItems(usage, sections, activeTools, noSystemPrompt).map(i => i.line);
}

/** Build breakdown items with drillable section data */
export function buildBreakdownItems(
  usage: ContextUsage | null,
  sections: PromptSection[],
  activeTools: string[],
  noSystemPrompt = false,
): BreakdownItem[] {
  const items: BreakdownItem[] = [];

  // Header — format: "Context Breakdown (~50K / 200K tokens, 25%)"
  const headerParts: string[] = [];
  if (usage?.tokens != null && usage?.contextWindow != null) {
    headerParts.push(`~${formatTokens(usage.tokens)} / ${formatTokens(usage.contextWindow)} tokens`);
  } else if (usage?.tokens != null) {
    headerParts.push(`~${formatTokens(usage.tokens)} tokens`);
  } else if (usage?.contextWindow != null) {
    headerParts.push(`${formatTokens(usage.contextWindow)} window`);
  }
  if (usage?.percent != null) headerParts.push(`${usage.percent}%`);
  const header = headerParts.length > 0
    ? `Context Breakdown (${headerParts.join(", ")})`
    : "Context Breakdown";
  items.push({ line: header });
  items.push({ line: "\u2500".repeat(44) });

  // System prompt sections
  if (sections.length > 0) {
    const totalBytes = sections.reduce((sum, s) => sum + s.bytes, 0);
    const totalTok = estimateTokens(sections.reduce((acc, s) => acc + s.content, ""));

    const onlyBase = sections.length === 1 && sections[0].label === "Base system prompt";
    if (onlyBase) {
      items.push({
        line: `  System Prompt  ${formatSize(totalBytes)}  ~${formatTokens(totalTok)} tok`,
        section: sections[0],
      });
    } else {
      const allContent = sections.map(s => s.content).join("\n\n");
      items.push({
        line: `  System Prompt  ${formatSize(totalBytes)}  ~${formatTokens(totalTok)} tok`,
        section: { label: "System Prompt (all sections)", bytes: totalBytes, content: allContent },
      });
      for (let i = 0; i < sections.length; i++) {
        const s = sections[i];
        const isLast = i === sections.length - 1;
        const prefix = isLast ? "\u2514" : "\u251c";
        const tok = estimateTokens(s.content);
        items.push({
          line: `    ${prefix} ${s.label}  ${formatSize(s.bytes)}  ~${formatTokens(tok)} tok`,
          section: s,
        });
      }
    }
  }

  // Empty prompt fallback
  if (noSystemPrompt && sections.length === 0) {
    items.push({ line: "  No system prompt captured" });
  }

  // Tools
  items.push({
    line: `  Tools: ${activeTools.length} active`,
    toolNames: activeTools.length > 0 ? activeTools : undefined,
  });

  // Footer
  items.push({ line: "\u2500".repeat(34) });
  items.push({ line: "  Close" });

  return items;
}

// ── Internal helpers ──────────────────────────────────────

function byteLength(str: string): number {
  return new TextEncoder().encode(str).length;
}

function extractXmlSections(
  text: string,
  sections: PromptSection[],
  consumed: Set<number>,
): void {
  // Project section FIRST (so nested <file> tags inside the wrapper are consumed).
  // Modern OMP uses `<|START_PROJECT|>...<|END_PROJECT|>` pipe markers; older OMP
  // and synthetic test inputs use the legacy `<project>...</project>` XML form.
  const projectPatterns: RegExp[] = [
    /<\|START_PROJECT\|>[\s\S]*?<\|END_PROJECT\|>/,
    /<project>[\s\S]*?<\/project>/,
  ];
  for (const pattern of projectPatterns) {
    const projMatch = text.match(pattern);
    if (!projMatch) continue;
    sections.push({
      label: "Project context",
      bytes: byteLength(projMatch[0]),
      content: projMatch[0],
    });
    markConsumed(consumed, projMatch.index!, projMatch.index! + projMatch[0].length);
    break;
  }

  // Environment envelope (OMP ≥14.9.3) — workstation, tool catalog, LSP guidance.
  const envMatch = text.match(/<\|START_ENV\|>[\s\S]*?<\|END_ENV\|>/);
  if (envMatch) {
    sections.push({
      label: "Environment",
      bytes: byteLength(envMatch[0]),
      content: envMatch[0],
    });
    markConsumed(consumed, envMatch.index!, envMatch.index! + envMatch[0].length);
  }

  // Contract envelope (OMP ≥14.9.3) — inviolable rules, yielding criteria.
  const contractMatch = text.match(/<\|START_CONTRACT\|>[\s\S]*?<\|END_CONTRACT\|>/);
  if (contractMatch) {
    sections.push({
      label: "Contract",
      bytes: byteLength(contractMatch[0]),
      content: contractMatch[0],
    });
    markConsumed(consumed, contractMatch.index!, contractMatch.index! + contractMatch[0].length);
  }

  // File sections — skip if already consumed (e.g., nested inside <project>)
  const fileRegex = /<file\s+path="([^"]*)">[\s\S]*?<\/file>/g;
  let match;
  while ((match = fileRegex.exec(text)) !== null) {
    if (consumed.has(match.index)) continue;
    const filePath = match[1];
    const content = match[0];
    const label = filePath.toLowerCase().endsWith("agents.md")
      ? "AGENTS.md"
      : `File: ${basename(filePath) || filePath}`;
    sections.push({ label, bytes: byteLength(content), content });
    markConsumed(consumed, match.index, match.index + content.length);
  }

  // Skills section — try <skills> wrapper first, fall back to bare <skill> tags
  const skillsMatch = text.match(/<skills>([\s\S]*?)<\/skills>/);
  if (skillsMatch) {
    const content = skillsMatch[0];
    const skillCount = (skillsMatch[1].match(/<skill\s+name="/g) || []).length;
    sections.push({
      label: `Skills (${skillCount})`,
      bytes: byteLength(content),
      content,
    });
    markConsumed(consumed, skillsMatch.index!, skillsMatch.index! + content.length);
  } else {
    // Bare <skill> tags without wrapper
    const bareSkillRegex = /<skill\s+name="[^"]*">[\s\S]*?<\/skill>/g;
    let bareMatch;
    let skillContent = "";
    let skillCount = 0;
    while ((bareMatch = bareSkillRegex.exec(text)) !== null) {
      if (consumed.has(bareMatch.index)) continue;
      skillContent += bareMatch[0];
      skillCount++;
      markConsumed(consumed, bareMatch.index, bareMatch.index + bareMatch[0].length);
    }
    if (skillCount > 0) {
      sections.push({
        label: `Skills (${skillCount})`,
        bytes: byteLength(skillContent),
        content: skillContent,
      });
    }
  }
}

function extractHeadingSections(
  text: string,
  sections: PromptSection[],
  consumed: Set<number>,
): void {
  const headingPatterns: Array<{ pattern: RegExp; label: string }> = [
    { pattern: /^# Memory Guidance\b/m, label: "Memory" },
    { pattern: /^# (?:supi-)?context-mode — MANDATORY routing rules\b/m, label: "Routing rules" },
    { pattern: /^## MCP Server Instructions\b/m, label: "MCP instructions" },
  ];

  for (const { pattern, label } of headingPatterns) {
    const globalPattern = new RegExp(pattern.source, "gm");
    let merged = "";
    let match;
    while ((match = globalPattern.exec(text)) !== null) {
      if (consumed.has(match.index)) continue;
      const rest = text.slice(match.index + match[0].length);
      const nextHeading = rest.search(/^#{1,2}\s/m);
      const end = nextHeading === -1
        ? text.length
        : match.index + match[0].length + nextHeading;
      const content = text.slice(match.index, end);
      merged += content;
      markConsumed(consumed, match.index, end);
    }
    if (merged.length > 0) {
      sections.push({ label, bytes: byteLength(merged), content: merged });
    }
  }

  // Skills aggregate (OMP ≥14.7): markdown bullet list under `# Skills`.
  // The legacy `<skills>` XML form is handled in extractXmlSections; this picks
  // up the modern markdown shape rendered by OMP runtime. Bounded by the next
  // h1/h2 heading so we don't swallow MCP instructions / Tools blocks.
  const skillsHeading = text.match(/^# Skills\b[^\n]*\n/m);
  if (skillsHeading && !consumed.has(skillsHeading.index!)) {
    const start = skillsHeading.index!;
    const afterHeading = text.slice(start + skillsHeading[0].length);
    const nextHeading = afterHeading.search(/^#{1,2}\s/m);
    const end = nextHeading === -1
      ? text.length
      : start + skillsHeading[0].length + nextHeading;
    const content = text.slice(start, end);
    const bulletCount = (content.match(/^- [a-zA-Z0-9._-]+:/gm) || []).length;
    if (bulletCount > 0) {
      sections.push({ label: `Skills (${bulletCount})`, bytes: byteLength(content), content });
      markConsumed(consumed, start, end);
    }
  }

  // Also recognize bare memory:// blocks without a heading
  if (!sections.some((s) => s.label === "Memory")) {
    const memoryMatch = text.match(/memory:\/\/\S+/);
    if (memoryMatch && !consumed.has(memoryMatch.index!)) {
      const rest = text.slice(memoryMatch.index!);
      const nextHeading = rest.search(/\n#{1,2}\s/);
      const end = nextHeading === -1 ? text.length : memoryMatch.index! + nextHeading;
      const content = text.slice(memoryMatch.index!, end);
      sections.push({ label: "Memory", bytes: byteLength(content), content });
      markConsumed(consumed, memoryMatch.index!, end);
    }
  }
}

function markConsumed(consumed: Set<number>, start: number, end: number): void {
  for (let i = start; i < end; i++) consumed.add(i);
}

function collectUnconsumed(text: string, consumed: Set<number>): string {
  let result = "";
  for (let i = 0; i < text.length; i++) {
    if (!consumed.has(i)) result += text[i];
  }
  return result;
}


/** Format a section into a markdown report string */
export function formatSectionReport(section: PromptSection): string {
  const tok = estimateTokens(section.content);
  return [
    `# Context Breakdown: ${section.label}`,
    "",
    `> ${formatSize(section.bytes)} | ~${formatTokens(tok)} tokens`,
    "",
    "---",
    "",
    section.content,
    "",
  ].join("\n");
}

/** Format tools list into a markdown report string */
export function formatToolsReport(toolNames: string[]): string {
  return [
    "# Context Breakdown: Active Tools",
    "",
    `> ${toolNames.length} tools active`,
    "",
    "---",
    "",
    ...toolNames.map(t => `- ${t}`),
    "",
  ].join("\n");
}