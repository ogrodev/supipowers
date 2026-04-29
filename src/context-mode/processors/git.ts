import type { ProcessorContext, ProcessorInvariant, ProcessorOutput } from "./types.js";

const encoder = new TextEncoder();

export const GIT_INVARIANT: ProcessorInvariant = {
  key: "git",
  maxBytes: 4096,
  preserve: [
    "branch line",
    "per-path status codes",
    "rename from/to lines",
    "hunk markers",
    "net plus/minus counts",
    "last five commits",
  ],
};

function normalizeEol(text: string, eol: ProcessorContext["eol"]): string {
  return text.replace(/\r?\n/g, eol);
}

function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

function capText(text: string, maxBytes: number, eol: ProcessorContext["eol"]): string {
  if (byteLength(text) <= maxBytes) return text;

  const lines = text.split(/\r?\n/);
  const marker = `[...git processor omitted ${lines.length} original lines to stay under ${maxBytes} bytes...]`;
  const kept: string[] = [];
  for (const line of lines) {
    const candidate = [...kept, line, marker].join(eol);
    if (byteLength(candidate) > maxBytes) break;
    kept.push(line);
  }

  let capped = [...kept, marker].join(eol);
  while (byteLength(capped) > maxBytes && kept.length > 0) {
    kept.pop();
    capped = [...kept, marker].join(eol);
  }
  return capped;
}

function countDiffChanges(text: string): { plus: number; minus: number } {
  let plus = 0;
  let minus = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) plus += 1;
    if (line.startsWith("-")) minus += 1;
  }
  return { plus, minus };
}

function looksLikeDiff(text: string): boolean {
  return /^diff --git /m.test(text) || /^@@ /m.test(text);
}

function looksLikeLog(text: string): boolean {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return false;
  return lines.every((line) => /^[0-9a-z]{7,40}\s+/.test(line));
}

function looksLikeStatus(text: string): boolean {
  return /^##\s+/m.test(text) || /^(?:[ MARC?D!U]{1,2}|R\s)\s+\S/m.test(text);
}

function compressDiff(text: string, ctx: ProcessorContext): string {
  const normalized = normalizeEol(text, ctx.eol);
  const { plus, minus } = countDiffChanges(text);
  return capText(`Net changes: +${plus} -${minus}${ctx.eol}${normalized}`, GIT_INVARIANT.maxBytes, ctx.eol);
}

function compressLog(text: string, ctx: ProcessorContext): string {
  const normalized = normalizeEol(text, ctx.eol);
  const lines = normalized.split(ctx.eol).filter(Boolean);
  if (lines.length <= 10) return capText(normalized, GIT_INVARIANT.maxBytes, ctx.eol);
  const head = lines.slice(0, 5);
  const tail = lines.slice(-5);
  return capText(
    [...head, `[...git log omitted ${lines.length - head.length - tail.length} commits...]`, ...tail].join(ctx.eol),
    GIT_INVARIANT.maxBytes,
    ctx.eol,
  );
}

function compressStatusOrOther(text: string, ctx: ProcessorContext): string {
  return capText(normalizeEol(text, ctx.eol), GIT_INVARIANT.maxBytes, ctx.eol);
}

export function gitProcessor(text: string, ctx: ProcessorContext): ProcessorOutput {
  if (ctx.exitCode !== null && ctx.exitCode !== 0) {
    return { text, processorKey: "git", passthrough: true };
  }

  let compressed: string;
  if (looksLikeDiff(text)) {
    compressed = compressDiff(text, ctx);
  } else if (looksLikeLog(text)) {
    compressed = compressLog(text, ctx);
  } else if (looksLikeStatus(text)) {
    compressed = compressStatusOrOther(text, ctx);
  } else {
    compressed = compressStatusOrOther(text, ctx);
  }

  return { text: compressed, processorKey: "git", passthrough: false };
}
