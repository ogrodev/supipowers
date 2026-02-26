import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ParsedQaArgs {
  workflow?: string;
  workflowSource: "none" | "inline" | "file";
  workflowFilePath?: string;
  targetUrl?: string;
}

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
}

export function parseCommandLines(raw: string): string[] {
  return raw
    .split(/[\n;]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function parseUrlToken(tokens: string[]): { targetUrl?: string; filteredTokens: string[] } {
  const filtered: string[] = [];
  let targetUrl: string | undefined;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];

    if (token.startsWith("--url=")) {
      targetUrl = stripQuotes(token.slice("--url=".length));
      continue;
    }

    if (token === "--url") {
      const next = tokens[i + 1];
      if (next) {
        targetUrl = stripQuotes(next);
        i += 1;
      }
      continue;
    }

    filtered.push(token);
  }

  return {
    targetUrl,
    filteredTokens: filtered,
  };
}

function extractWorkflowFromFile(cwd: string, token: string): { content?: string; filePath?: string } {
  const normalized = token.startsWith("@") ? token.slice(1) : token;
  const absolute = normalized.startsWith("/") ? normalized : join(cwd, normalized);

  if (!existsSync(absolute)) return {};

  try {
    const content = readFileSync(absolute, "utf-8").trim();
    if (!content) return {};
    return {
      content,
      filePath: absolute,
    };
  } catch {
    return {};
  }
}

export function parseQaArgs(rawArgs: string, cwd: string): ParsedQaArgs {
  const trimmed = rawArgs.trim();
  if (!trimmed) {
    return {
      workflowSource: "none",
    };
  }

  const tokens = trimmed.split(/\s+/).filter((token) => token.length > 0);
  const { targetUrl, filteredTokens } = parseUrlToken(tokens);

  if (filteredTokens.length === 1) {
    const candidate = extractWorkflowFromFile(cwd, filteredTokens[0]);
    if (candidate.content) {
      return {
        workflow: candidate.content,
        workflowSource: "file",
        workflowFilePath: candidate.filePath,
        targetUrl,
      };
    }
  }

  if (filteredTokens[0]?.startsWith("@")) {
    const candidate = extractWorkflowFromFile(cwd, filteredTokens[0]);
    if (candidate.content) {
      return {
        workflow: candidate.content,
        workflowSource: "file",
        workflowFilePath: candidate.filePath,
        targetUrl,
      };
    }
  }

  return {
    workflow: filteredTokens.join(" ").trim() || undefined,
    workflowSource: "inline",
    targetUrl,
  };
}
