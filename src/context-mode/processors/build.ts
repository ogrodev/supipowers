import type { ProcessorContext, ProcessorInvariant, ProcessorOutput } from "./types.js";

const encoder = new TextEncoder();

export const BUILD_INVARIANT: ProcessorInvariant = {
  key: "build",
  maxBytes: 8192,
  preserve: ["error diagnostics", "file/line/column", "warnings", "summary tail"],
};

const ERROR_SHAPE_RE = /\b(?:error|ERROR|failed|FAIL)\b|\S+\.ts\(\d+,\d+\)|\S+\.(?:rs|go|ts):\d+:\d+/i;

function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

function normalizeEol(text: string, eol: ProcessorContext["eol"]): string {
  return text.replace(/\r?\n/g, eol);
}

function isImportant(line: string): boolean {
  return ERROR_SHAPE_RE.test(line)
    || /\bwarning\b/i.test(line)
    || /^\s*-->/i.test(line)
    || /^\s*\d+ \|/.test(line)
    || /^\s*[\^╵]/.test(line)
    || /Found \d+ errors?|\d+ errors?|could not compile|Build failed/i.test(line);
}

function capLines(lines: string[], eol: ProcessorContext["eol"]): string {
  let output = lines.join(eol);
  if (byteLength(output) <= BUILD_INVARIANT.maxBytes) return output;

  const marker = `[...build processor omitted lines to stay under ${BUILD_INVARIANT.maxBytes} bytes...]`;
  const kept: string[] = [];
  for (const line of lines) {
    const candidate = [...kept, line, marker].join(eol);
    if (byteLength(candidate) > BUILD_INVARIANT.maxBytes) break;
    kept.push(line);
  }
  output = [...kept, marker].join(eol);
  while (byteLength(output) > BUILD_INVARIANT.maxBytes && kept.length > 0) {
    kept.pop();
    output = [...kept, marker].join(eol);
  }
  return output;
}

export function buildProcessor(text: string, ctx: ProcessorContext): ProcessorOutput {
  if (!ERROR_SHAPE_RE.test(text)) {
    return { text, processorKey: "build", passthrough: true };
  }

  const normalized = normalizeEol(text, ctx.eol);
  const lines = normalized.split(ctx.eol);
  const keep = new Set<number>();
  for (let index = 0; index < lines.length; index += 1) {
    if (!isImportant(lines[index])) continue;
    keep.add(index);
    if (index > 0) keep.add(index - 1);
    if (index + 1 < lines.length) keep.add(index + 1);
  }

  const selected = [...keep].sort((a, b) => a - b).map((index) => lines[index]);
  return { text: capLines(selected.length > 0 ? selected : lines, ctx.eol), processorKey: "build", passthrough: false };
}
