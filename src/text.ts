/** Normalizes Windows CRLF line endings to LF. */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/** Removes a single outer markdown code fence wrapper when present. */
export function stripMarkdownCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }

  const lines = trimmed.split("\n");
  if (lines.length >= 3 && lines[0]!.startsWith("```") && lines[lines.length - 1] === "```") {
    return lines.slice(1, -1).join("\n").trim();
  }

  return trimmed;
}
