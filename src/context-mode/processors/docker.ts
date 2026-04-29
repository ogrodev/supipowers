import type { ProcessorContext, ProcessorInvariant, ProcessorOutput } from "./types.js";

const encoder = new TextEncoder();

export const DOCKER_INVARIANT: ProcessorInvariant = {
  key: "docker",
  maxBytes: 8192,
  preserve: ["table headers", "12-character ids", "names", "statuses", "last 20 log lines"],
};

function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

function normalizeEol(text: string, eol: ProcessorContext["eol"]): string {
  return text.replace(/\r?\n/g, eol);
}

function capLines(lines: string[], eol: ProcessorContext["eol"]): string {
  let output = lines.join(eol);
  if (byteLength(output) <= DOCKER_INVARIANT.maxBytes) return output;
  const marker = `[...docker processor omitted lines to stay under ${DOCKER_INVARIANT.maxBytes} bytes...]`;
  const kept: string[] = [];
  for (const line of lines) {
    const candidate = [...kept, line, marker].join(eol);
    if (byteLength(candidate) > DOCKER_INVARIANT.maxBytes) break;
    kept.push(line);
  }
  return [...kept, marker].join(eol);
}

function isDockerTable(lines: string[]): boolean {
  return lines.some((line) => /\b(?:CONTAINER ID|IMAGE ID)\b/.test(line));
}

function isBuildOutput(lines: string[]): boolean {
  return lines.some((line) => /\bERROR\b|failed to solve|exit code:/i.test(line));
}

export function dockerProcessor(text: string, ctx: ProcessorContext): ProcessorOutput {
  const normalized = normalizeEol(text, ctx.eol);
  const lines = normalized.split(ctx.eol).filter((line) => line.length > 0);

  let compressed: string | null = null;
  if (isDockerTable(lines)) {
    compressed = capLines(lines, ctx.eol);
  } else if (isBuildOutput(lines)) {
    compressed = capLines(lines.filter((line) => /#\d+|ERROR|failed|exit code/i.test(line)), ctx.eol);
  } else if (lines.length > 20) {
    compressed = capLines(lines.slice(-20), ctx.eol);
  }

  if (compressed === null) {
    return { text, processorKey: "docker", passthrough: true };
  }
  return { text: compressed, processorKey: "docker", passthrough: false };
}
