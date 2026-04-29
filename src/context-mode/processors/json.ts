import type { ProcessorContext, ProcessorInvariant, ProcessorOutput } from "./types.js";

const encoder = new TextEncoder();

export const JSON_INVARIANT: ProcessorInvariant = {
  key: "json",
  maxBytes: 4096,
  preserve: [
    "top-level keys",
    "array item counts",
    "first five array elements",
    "nested object key counts",
    "parse failures passthrough",
  ],
};

function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

function tryParseJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed !== null && (Array.isArray(parsed) || typeof parsed === "object") ? parsed : null;
  } catch {
    return null;
  }
}

export function jsonContentSniff(text: string): boolean {
  return tryParseJson(text) !== null;
}

function summarizeValue(value: unknown): string {
  if (Array.isArray(value)) return `array(items=${value.length})`;
  if (value === null) return "null";
  switch (typeof value) {
    case "object":
      return `object(keys=${Object.keys(value as Record<string, unknown>).length})`;
    case "string":
      return `string(len=${value.length})`;
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return typeof value;
  }
}

function summarizeArrayItem(value: unknown): string {
  if (Array.isArray(value)) return `[array(${value.length})]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).join(", ")}}`;
  }
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

function capLines(lines: string[], eol: ProcessorContext["eol"]): string {
  let output = lines.join(eol);
  if (byteLength(output) <= JSON_INVARIANT.maxBytes) return output;

  const marker = `[...json processor omitted lines to stay under ${JSON_INVARIANT.maxBytes} bytes...]`;
  const kept: string[] = [];
  for (const line of lines) {
    const candidate = [...kept, line, marker].join(eol);
    if (byteLength(candidate) > JSON_INVARIANT.maxBytes) break;
    kept.push(line);
  }
  output = [...kept, marker].join(eol);
  while (byteLength(output) > JSON_INVARIANT.maxBytes && kept.length > 0) {
    kept.pop();
    output = [...kept, marker].join(eol);
  }
  return output;
}

function summarizeObject(value: Record<string, unknown>, ctx: ProcessorContext): string {
  const keys = Object.keys(value);
  const lines = [
    "JSON summary",
    "type: object",
    `topLevelKeys (${keys.length}): ${keys.join(", ")}`,
  ];
  for (const key of keys) {
    lines.push(`${key}: ${summarizeValue(value[key])}`);
  }
  return capLines(lines, ctx.eol);
}

function summarizeArray(value: unknown[], ctx: ProcessorContext): string {
  const lines = ["JSON summary", "type: array", `items: ${value.length}`];
  value.slice(0, 5).forEach((item, index) => {
    lines.push(`[${index}]: ${summarizeArrayItem(item)}`);
  });
  return capLines(lines, ctx.eol);
}

export function jsonProcessor(text: string, ctx: ProcessorContext): ProcessorOutput {
  const parsed = tryParseJson(text);
  if (parsed === null) {
    return { text, processorKey: "json", passthrough: true };
  }

  const summary = Array.isArray(parsed)
    ? summarizeArray(parsed, ctx)
    : summarizeObject(parsed as Record<string, unknown>, ctx);
  return { text: summary, processorKey: "json", passthrough: false };
}
