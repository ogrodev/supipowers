import * as fs from "node:fs";
import * as path from "node:path";
import type { PlatformPaths } from "../platform/types.js";

export type DebugSessionContext = {
  cwd?: string;
  sessionManager?: { getSessionFile?: () => string } | null;
};

export interface DebugLogger {
  enabled: boolean;
  tool: string;
  sessionId: string;
  filePath: string | null;
  log(event: string, data?: Record<string, unknown>): void;
}

const TRUTHY_DEBUG_VALUES = new Set(["1", "true", "yes", "on"]);

export function isDebugEnabled(): boolean {
  const value = process.env.SUPI_DEBUG?.trim().toLowerCase();
  return value != null && TRUTHY_DEBUG_VALUES.has(value);
}

function sanitizeSegment(value: string): string {
  return value
    .trim()
    .replace(/\.[^./\\]+$/, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .toLowerCase();
}

function resolveSessionMetadata(ctx?: DebugSessionContext): {
  sessionId: string;
  sessionFile: string | null;
} {
  try {
    const sessionFile = ctx?.sessionManager?.getSessionFile?.();
    if (typeof sessionFile === "string" && sessionFile.length > 0) {
      const baseName = path.basename(sessionFile);
      const sessionId = sanitizeSegment(baseName) || "unknown-session";
      return { sessionId, sessionFile };
    }
  } catch {
    // Debug logging must never break the main workflow.
  }

  return { sessionId: `process-${process.pid}`, sessionFile: null };
}

function appendJsonLine(filePath: string, entry: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(entry) + "\n");
}

export function createDebugLogger(
  paths: PlatformPaths,
  ctx: DebugSessionContext | undefined,
  tool: string,
): DebugLogger {
  const cwd = ctx?.cwd ?? process.cwd();
  const { sessionId, sessionFile } = resolveSessionMetadata(ctx);
  const sanitizedTool = sanitizeSegment(tool) || "unknown-tool";

  if (!isDebugEnabled()) {
    return {
      enabled: false,
      tool: sanitizedTool,
      sessionId,
      filePath: null,
      log() {},
    };
  }

  const filePath = paths.project(cwd, "debug", `tool-${sanitizedTool}__session-${sessionId}.jsonl`);

  const logger: DebugLogger = {
    enabled: true,
    tool: sanitizedTool,
    sessionId,
    filePath,
    log(event, data = {}) {
      try {
        appendJsonLine(filePath, {
          ts: new Date().toISOString(),
          tool: sanitizedTool,
          sessionId,
          event,
          data,
        });
      } catch {
        // Debug logging must never block the primary code path.
      }
    },
  };

  logger.log("debug_logger_initialized", {
    cwd,
    filePath,
    sessionFile,
    env: process.env.SUPI_DEBUG ?? null,
  });

  return logger;
}
