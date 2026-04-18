import type { UiDesignBackendId } from "./types.js";
import { createLocalHtmlBackend } from "./backends/local-html.js";

/**
 * Session-start options passed by the command handler to a backend.
 * `sessionDir` is created by the caller; the adapter never creates it.
 */
export interface BackendStartSessionOptions {
  sessionDir: string;
  port?: number;
}

/**
 * Handle returned by `startSession` — the canonical shape.
 * `cleanup()` is idempotent; callers may invoke it multiple times.
 */
export interface BackendStartResult {
  url: string;
  cleanup: () => Promise<void>;
}

export type BackendFinalizeReason = "complete" | "discarded";

/**
 * Backend contract. Implementations manage the lifecycle of the artifact
 * surface (HTTP companion, MCP connection, etc.) — they do NOT own manifest.json.
 */
export interface UiDesignBackend {
  id: UiDesignBackendId;
  startSession(opts: BackendStartSessionOptions): Promise<BackendStartResult>;
  artifactUrl(sessionDir: string, artifactPath: string): string | null;
  finalize(sessionDir: string, reason: BackendFinalizeReason): Promise<void>;
}

/** Thrown when a requested backend cannot be provided. */
export class BackendUnavailableError extends Error {
  readonly code = "backend-unavailable" as const;
  constructor(message: string) {
    super(message);
    this.name = "BackendUnavailableError";
  }
}

/**
 * Resolve a backend by id. Only `local-html` is supported in v1 — future
 * MCP-based backends (pencil, figma, paper) will register through the same
 * factory.
 */
export function getBackend(id: UiDesignBackendId): UiDesignBackend {
  if (id === "local-html") {
    return createLocalHtmlBackend();
  }
  throw new BackendUnavailableError(
    `Backend '${id}' is not available in v1. Supported: local-html.`,
  );
}
