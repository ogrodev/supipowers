import { parse as parseYaml } from "yaml";
import { normalizeLineEndings } from "./text.js";

export type MarkdownFrontmatterErrorCode =
  | "missing-frontmatter"
  | "invalid-frontmatter"
  | "empty-body";

export class MarkdownFrontmatterError extends Error {
  constructor(
    public readonly code: MarkdownFrontmatterErrorCode,
    public readonly filePath: string,
    message: string,
  ) {
    super(message);
    this.name = "MarkdownFrontmatterError";
  }
}

export interface ParsedMarkdownFrontmatter {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function parseMarkdownFrontmatter(content: string, filePath: string): ParsedMarkdownFrontmatter {
  const normalized = normalizeLineEndings(content);
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    throw new MarkdownFrontmatterError(
      "missing-frontmatter",
      filePath,
      `${filePath} is missing YAML frontmatter.`,
    );
  }

  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(match[1]);
  } catch (error) {
    throw new MarkdownFrontmatterError(
      "invalid-frontmatter",
      filePath,
      `Invalid YAML frontmatter in ${filePath}: ${(error as Error).message}`,
    );
  }

  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    throw new MarkdownFrontmatterError(
      "invalid-frontmatter",
      filePath,
      `Invalid YAML frontmatter in ${filePath}: frontmatter must be a mapping.`,
    );
  }

  const body = match[2]?.trim() ?? "";
  if (!body) {
    throw new MarkdownFrontmatterError(
      "empty-body",
      filePath,
      `${filePath} has an empty prompt body.`,
    );
  }

  return {
    frontmatter: frontmatter as Record<string, unknown>,
    body,
  };
}
