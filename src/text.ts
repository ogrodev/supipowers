/** Normalizes CRLF and lone CR line endings to LF for deterministic artifacts. */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** Ensures text files have a trailing LF without changing already-terminated content. */
export function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
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
