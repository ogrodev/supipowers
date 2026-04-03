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

// ── Internal helpers ──────────────────────────────────────

function byteLength(str: string): number {
  return new TextEncoder().encode(str).length;
}

function extractXmlSections(
  text: string,
  sections: PromptSection[],
  consumed: Set<number>,
): void {
  // Project section FIRST (so nested <file> tags inside <project> are consumed)
  const projMatch = text.match(/<project>([\s\S]*?)<\/project>/);
  if (projMatch) {
    sections.push({
      label: "Project context",
      bytes: byteLength(projMatch[0]),
      content: projMatch[0],
    });
    markConsumed(consumed, projMatch.index!, projMatch.index! + projMatch[0].length);
  }

  // Instructions section
  const instrMatch = text.match(/<instructions>([\s\S]*?)<\/instructions>/);
  if (instrMatch) {
    sections.push({
      label: "Extension instructions",
      bytes: byteLength(instrMatch[0]),
      content: instrMatch[0],
    });
    markConsumed(consumed, instrMatch.index!, instrMatch.index! + instrMatch[0].length);
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
      : `File: ${filePath.split("/").pop() || filePath}`;
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
    { pattern: /^# context-mode — MANDATORY routing rules\b/m, label: "Routing rules" },
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
