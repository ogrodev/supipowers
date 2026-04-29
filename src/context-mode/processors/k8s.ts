import type { ProcessorContext, ProcessorInvariant, ProcessorOutput } from "./types.js";

const encoder = new TextEncoder();

export const K8S_INVARIANT: ProcessorInvariant = {
  key: "k8s",
  maxBytes: 8192,
  preserve: ["get headers", "resource status", "describe name/status/events", "last 20 log lines"],
};

function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

function normalizeEol(text: string, eol: ProcessorContext["eol"]): string {
  return text.replace(/\r?\n/g, eol);
}

function capLines(lines: string[], eol: ProcessorContext["eol"]): string {
  let output = lines.join(eol);
  if (byteLength(output) <= K8S_INVARIANT.maxBytes) return output;
  const marker = `[...k8s processor omitted lines to stay under ${K8S_INVARIANT.maxBytes} bytes...]`;
  const kept: string[] = [];
  for (const line of lines) {
    const candidate = [...kept, line, marker].join(eol);
    if (byteLength(candidate) > K8S_INVARIANT.maxBytes) break;
    kept.push(line);
  }
  return [...kept, marker].join(eol);
}

function isGetTable(lines: string[]): boolean {
  return lines.some((line) => /\bNAME\b/.test(line) && /\bSTATUS\b/.test(line));
}

function isDescribe(lines: string[]): boolean {
  return lines.some((line) => line.startsWith("Name:")) && lines.some((line) => line.startsWith("Status:"));
}

function compressDescribe(lines: string[], eol: ProcessorContext["eol"]): string {
  const keep = new Set<number>();
  const eventsIndex = lines.findIndex((line) => line.startsWith("Events:"));
  lines.forEach((line, index) => {
    if (/^(Name|Namespace|Status):/.test(line)) keep.add(index);
    if (eventsIndex >= 0 && index >= eventsIndex) keep.add(index);
  });
  return capLines([...keep].sort((a, b) => a - b).map((index) => lines[index]), eol);
}

export function k8sProcessor(text: string, ctx: ProcessorContext): ProcessorOutput {
  const normalized = normalizeEol(text, ctx.eol);
  const lines = normalized.split(ctx.eol).filter((line) => line.length > 0);

  let compressed: string | null = null;
  if (isGetTable(lines)) {
    compressed = capLines(lines, ctx.eol);
  } else if (isDescribe(lines)) {
    compressed = compressDescribe(lines, ctx.eol);
  } else if (lines.length > 20) {
    compressed = capLines(lines.slice(-20), ctx.eol);
  }

  if (compressed === null) {
    return { text, processorKey: "k8s", passthrough: true };
  }
  return { text: compressed, processorKey: "k8s", passthrough: false };
}
