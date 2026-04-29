import type { ProcessorContext, ProcessorInvariant, ProcessorOutput } from "./types.js";

const encoder = new TextEncoder();

export const TEST_RUNNER_INVARIANT: ProcessorInvariant = {
  key: "test",
  maxBytes: 16384,
  preserve: [
    "failure labels",
    "passing labels",
    "file:line:column stack locations",
    "expectation messages",
    "final summary",
    "test counts",
  ],
};

function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

function normalizeEol(text: string, eol: ProcessorContext["eol"]): string {
  return text.replace(/\r?\n/g, eol);
}

function hasTestRunnerTokens(text: string): boolean {
  return /\b(?:bun test|vitest|jest)\b/i.test(text)
    || /\b(?:FAIL|PASS)\b/.test(text)
    || /\((?:fail|pass)\)/i.test(text)
    || /\b(?:Test Files|Test Suites|Tests:|Ran \d+ tests?)\b/i.test(text);
}

function isFailureRun(text: string): boolean {
  return /\bFAIL\b/.test(text)
    || /\(fail\)/i.test(text)
    || /\b[1-9]\d*\s+fail(?:ed)?\b/i.test(text);
}

function isSummaryLine(line: string): boolean {
  return /\b(?:Test Files|Test Suites|Tests:|Snapshots:|Time:|Ran |Duration|Start at)\b/i.test(line)
    || /^\s*\d+\s+(?:pass|fail)\b/i.test(line)
    || /^\s*\d+\s+expect\(\) calls\b/i.test(line);
}

function isImportantFailureLine(line: string): boolean {
  return /\b(?:FAIL|PASS)\b/.test(line)
    || /\((?:fail|pass)\)/i.test(line)
    || /(?:^|[\s(])\S+\.test\.[tj]sx?:\d+:\d+/.test(line)
    || /\b(?:error|Error|AssertionError|Expected|Received|expect\()\b/.test(line)
    || isSummaryLine(line);
}

function capText(lines: string[], maxBytes: number, eol: ProcessorContext["eol"]): string {
  let output = lines.join(eol);
  if (byteLength(output) <= maxBytes) return output;

  const marker = `[...test-runner processor omitted ${lines.length} lines to stay under ${maxBytes} bytes...]`;
  const kept: string[] = [];
  for (const line of lines) {
    const candidate = [...kept, line, marker].join(eol);
    if (byteLength(candidate) > maxBytes) break;
    kept.push(line);
  }
  output = [...kept, marker].join(eol);
  while (byteLength(output) > maxBytes && kept.length > 0) {
    kept.pop();
    output = [...kept, marker].join(eol);
  }
  return output;
}

function compressPassingRun(lines: string[], ctx: ProcessorContext): string {
  const summary = lines.filter(isSummaryLine);
  return capText(summary.length > 0 ? summary : lines.slice(-10), TEST_RUNNER_INVARIANT.maxBytes, ctx.eol);
}

function compressFailingRun(lines: string[], ctx: ProcessorContext): string {
  const keep = new Set<number>();
  for (let index = 0; index < lines.length; index += 1) {
    if (!isImportantFailureLine(lines[index])) continue;
    keep.add(index);
    if (index > 0) keep.add(index - 1);
    if (index + 1 < lines.length) keep.add(index + 1);
  }

  const kept = [...keep].sort((a, b) => a - b).map((index) => lines[index]);
  return capText(kept.length > 0 ? kept : lines, TEST_RUNNER_INVARIANT.maxBytes, ctx.eol);
}

export function testRunnerProcessor(text: string, ctx: ProcessorContext): ProcessorOutput {
  if (!hasTestRunnerTokens(text)) {
    return { text, processorKey: "test", passthrough: true };
  }

  const normalized = normalizeEol(text, ctx.eol);
  const lines = normalized.split(ctx.eol);
  const compressed = isFailureRun(normalized)
    ? compressFailingRun(lines, ctx)
    : compressPassingRun(lines, ctx);

  return { text: compressed, processorKey: "test", passthrough: false };
}
