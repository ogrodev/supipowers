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
