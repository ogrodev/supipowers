import type { ServerConfig } from "./types.js";

/** Extract $tags from user input, matching against registered server names */
export function parseTags(text: string, registeredNames: Set<string>): string[] {
  const tags: string[] = [];
  // Sort names by length (longest first) to match "figma-plugin" before "figma"
  const sorted = [...registeredNames].sort((a, b) => b.length - a.length);

  for (const name of sorted) {
    // Build regex: word-boundary-aware, case-insensitive
    const pattern = new RegExp(`(?:^|[\\s(])\\$${escapeRegex(name)}(?=$|[\\s).,;:!?])`, "gi");
    if (pattern.test(text)) {
      tags.push(name);
    }
  }

  return tags;
}

function escapeRegex(s: string): string {
  return s.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
}

/** Check if a trigger/antiTrigger matches the message */
function matchesAny(words: string[], message: string): boolean {
  const lower = message.toLowerCase();
  return words.some((w) => {
    const pattern = new RegExp(`\\b${escapeRegex(w.toLowerCase())}\\b`);
    return pattern.test(lower);
  });
}

/** Determine if a server should be active for this turn */
export function shouldActivate(
  config: ServerConfig,
  message: string,
  isTagged: boolean,
): boolean {
  if (!config.enabled) return false;

  // Tag overrides everything (if taggable)
  if (isTagged && config.taggable) return true;

  switch (config.activation) {
    case "always":
      return true;
    case "contextual": {
      const triggerMatch = config.triggers.length > 0 && matchesAny(config.triggers, message);
      if (!triggerMatch) return false;
      // AntiTrigger wins
      const antiMatch = config.antiTriggers.length > 0 && matchesAny(config.antiTriggers, message);
      return !antiMatch;
    }
    case "disabled":
      return false;
    default:
      return false;
  }
}

/** Compute which servers should be active for a given message */
export function computeActiveServers(
  servers: Record<string, ServerConfig>,
  message: string,
  taggedNames: string[],
): string[] {
  const tagSet = new Set(taggedNames);
  const active: string[] = [];

  for (const [name, config] of Object.entries(servers)) {
    if (shouldActivate(config, message, tagSet.has(name))) {
      active.push(name);
    }
  }

  return active;
}
