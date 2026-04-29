import type { ProcessorContext, ProcessorInvariant, ProcessorOutput } from "./types.js";

const encoder = new TextEncoder();

export const LINT_INVARIANT: ProcessorInvariant = {
  key: "lint",
  maxBytes: 8192,
  preserve: ["file/line/column", "severity", "rule name", "final tally"],
};

const DIAGNOSTIC_RE = /(?:\S+\.tsx?:\d+:\d+|^\s*\d+:\d+\s+(?:error|warning)|\b(?:error|warning)\b|\[warn\]|✖|⚠|\b(?:problems|Found \d+ error|Code style issues)\b)/i;

function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

function normalizeEol(text: string, eol: ProcessorContext["eol"]): string {
  return text.replace(/\r?\n/g, eol);
}

function hasDiagnostics(text: string): boolean {
  return DIAGNOSTIC_RE.test(text);
}

function isImportant(line: string): boolean {
  return DIAGNOSTIC_RE.test(line)
    || /^\S.*\.tsx?$/.test(line)
    || /^Checked \d+ files/i.test(line);
}

function capLines(lines: string[], eol: ProcessorContext["eol"]): string {
  let output = lines.join(eol);
  if (byteLength(output) <= LINT_INVARIANT.maxBytes) return output;

  const marker = `[...lint processor omitted lines to stay under ${LINT_INVARIANT.maxBytes} bytes...]`;
  const kept: string[] = [];
  for (const line of lines) {
    const candidate = [...kept, line, marker].join(eol);
    if (byteLength(candidate) > LINT_INVARIANT.maxBytes) break;
    kept.push(line);
  }
  output = [...kept, marker].join(eol);
  while (byteLength(output) > LINT_INVARIANT.maxBytes && kept.length > 0) {
    kept.pop();
    output = [...kept, marker].join(eol);
  }
  return output;
}

export function lintProcessor(text: string, ctx: ProcessorContext): ProcessorOutput {
  if (!hasDiagnostics(text)) {
    return { text, processorKey: "lint", passthrough: true };
  }

  const normalized = normalizeEol(text, ctx.eol);
  const lines = normalized.split(ctx.eol);
  const keep = new Set<number>();
  for (let index = 0; index < lines.length; index += 1) {
    if (!isImportant(lines[index])) continue;
    keep.add(index);
    if (index > 0 && /^\S/.test(lines[index - 1])) keep.add(index - 1);
    if (index + 1 < lines.length && /^\s+(?:✖|⚠|\d|[A-Z])/.test(lines[index + 1])) keep.add(index + 1);
  }

  const selected = [...keep].sort((a, b) => a - b).map((index) => lines[index]);
  return { text: capLines(selected.length > 0 ? selected : lines, ctx.eol), processorKey: "lint", passthrough: false };
}
