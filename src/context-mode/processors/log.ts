import type { ProcessorContext, ProcessorInvariant, ProcessorOutput } from "./types.js";

const encoder = new TextEncoder();

export const LOG_INVARIANT: ProcessorInvariant = {
  key: "log",
  maxBytes: 8192,
  preserve: [
    "last 30 timestamped lines",
    "up to 20 ERROR/FATAL/PANIC lines",
    "prompt-injection-shaped log lines verbatim",
    "EOL style",
  ],
};

const TIMESTAMP_RE = /^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?|[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}|\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\])/;
const IMPORTANT_RE = /\b(?:ERROR|FATAL|PANIC)\b|IGNORE PREVIOUS INSTRUCTIONS|system prompt|reveal secrets/i;

function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

function normalizeEol(text: string, eol: ProcessorContext["eol"]): string {
  return text.replace(/\r?\n/g, eol);
}

function nonBlankLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

function isTimestamped(line: string): boolean {
  return TIMESTAMP_RE.test(line);
}

export function logContentSniff(text: string): boolean {
  const lines = nonBlankLines(text);
  if (lines.length === 0) return false;
  const timestamped = lines.filter(isTimestamped).length;
  return timestamped / lines.length >= 0.8;
}

function capLines(lines: string[], eol: ProcessorContext["eol"]): string {
  let output = lines.join(eol);
  if (byteLength(output) <= LOG_INVARIANT.maxBytes) return output;

  const marker = `[...log processor omitted lines to stay under ${LOG_INVARIANT.maxBytes} bytes...]`;
  const kept: string[] = [];
  for (const line of lines) {
    const candidate = [...kept, line, marker].join(eol);
    if (byteLength(candidate) > LOG_INVARIANT.maxBytes) break;
    kept.push(line);
  }
  output = [...kept, marker].join(eol);
  while (byteLength(output) > LOG_INVARIANT.maxBytes && kept.length > 0) {
    kept.pop();
    output = [...kept, marker].join(eol);
  }
  return output;
}

export function logProcessor(text: string, ctx: ProcessorContext): ProcessorOutput {
  if (!logContentSniff(text)) {
    return { text, processorKey: "log", passthrough: true };
  }

  const normalized = normalizeEol(text, ctx.eol);
  const lines = normalized.split(ctx.eol).filter((line) => line.trim().length > 0);
  const timestamped = lines
    .map((line, index) => ({ line, index }))
    .filter((entry) => isTimestamped(entry.line));
  const lastTimestamped = timestamped.slice(-30);
  const important = lines
    .map((line, index) => ({ line, index }))
    .filter((entry) => IMPORTANT_RE.test(entry.line))
    .slice(0, 20);

  const keep = new Map<number, string>();
  for (const entry of important) keep.set(entry.index, entry.line);
  for (const entry of lastTimestamped) keep.set(entry.index, entry.line);

  const selected = [...keep.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, line]) => line);

  return { text: capLines(selected, ctx.eol), processorKey: "log", passthrough: false };
}
