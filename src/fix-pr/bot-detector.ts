import type { ReviewerType } from "./types.js";

interface DetectedReviewer {
  type: ReviewerType;
  triggerMethod: string;
  login: string;
}

/** Map of known bot login patterns → reviewer config */
const KNOWN_BOTS: Record<string, { type: ReviewerType; triggerMethod: string }> = {
  "coderabbitai[bot]": { type: "coderabbit", triggerMethod: "/review" },
  "github-copilot[bot]": { type: "copilot", triggerMethod: "@copilot review" },
  "copilot[bot]": { type: "copilot", triggerMethod: "@copilot review" },
  "gemini-code-review[bot]": { type: "gemini", triggerMethod: "/gemini review" },
};

/**
 * Detect bot reviewers from JSONL comment lines.
 * Parses each line, checks userType === "Bot", and maps to known reviewer types.
 */
export function detectBotReviewers(commentsJsonl: string): DetectedReviewer[] {
  const seen = new Set<string>();
  const results: DetectedReviewer[] = [];

  for (const line of commentsJsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const comment = JSON.parse(line);
      if (comment.userType !== "Bot") continue;
      if (seen.has(comment.user)) continue;
      seen.add(comment.user);

      const known = KNOWN_BOTS[comment.user];
      if (known) {
        results.push({ ...known, login: comment.user });
      }
    } catch { /* skip malformed lines */ }
  }

  return results;
}
