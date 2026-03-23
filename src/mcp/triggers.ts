import type { McpTool } from "./types.js";

const GENERIC_WORDS = new Set([
  "get", "set", "list", "create", "update", "delete", "read", "write",
  "find", "search", "fetch", "add", "remove", "the", "a", "an", "of",
  "from", "to", "in", "on", "is", "for", "and", "or", "with", "by",
  "all", "new", "this", "that", "it", "be", "are", "was", "has", "have",
  "will", "can", "do", "does", "not", "no", "if", "use", "using",
]);

const MAX_TRIGGERS = 10;

/** Split camelCase or snake_case into words */
function tokenize(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, "$1_$2") // camelCase → snake
    .toLowerCase()
    .split(/[_\-\s]+/)
    .filter((w) => w.length > 2); // skip tiny words
}

/** Extract keywords from description (simple stop-word filter) */
function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !GENERIC_WORDS.has(w));
}

export function generateTriggers(serverName: string, tools: McpTool[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  // Server name always first
  result.push(serverName);
  seen.add(serverName);

  for (const tool of tools) {
    // Tokenize tool name
    for (const word of tokenize(tool.name)) {
      if (!GENERIC_WORDS.has(word) && !seen.has(word)) {
        seen.add(word);
        result.push(word);
      }
    }

    // Extract from description
    if (tool.description) {
      for (const word of extractKeywords(tool.description)) {
        if (!seen.has(word)) {
          seen.add(word);
          result.push(word);
        }
      }
    }

    if (result.length >= MAX_TRIGGERS) break;
  }

  return result.slice(0, MAX_TRIGGERS);
}
