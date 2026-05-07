export type SystemPromptBlocks = string[];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function normalizeSystemPromptBlocks(value: unknown): SystemPromptBlocks {
  if (Array.isArray(value)) {
    return value.filter((block): block is string => typeof block === "string" && block.length > 0);
  }
  if (typeof value === "string") {
    return value.length > 0 ? [value] : [];
  }

  const record = asRecord(value);
  if (record && "systemPrompt" in record) {
    return normalizeSystemPromptBlocks(record.systemPrompt);
  }

  return [];
}

export function systemPromptText(value: unknown): string {
  return normalizeSystemPromptBlocks(value).join("\n\n");
}

export function appendSystemPromptBlock(value: unknown, block: string): SystemPromptBlocks {
  const blocks = normalizeSystemPromptBlocks(value);
  return block.length > 0 ? [...blocks, block] : blocks;
}

export function prependSystemPromptBlock(value: unknown, block: string): SystemPromptBlocks {
  const blocks = normalizeSystemPromptBlocks(value);
  return block.length > 0 ? [block, ...blocks] : blocks;
}
