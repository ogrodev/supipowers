import type { UiDesignBackendId } from "./types.js";
import { createLocalHtmlBackend } from "./backends/local-html.js";
import { createPencilMcpBackend } from "./backends/pencil-mcp.js";

/**
 * Session-start options passed by the command handler to a backend.
 * `sessionDir` is created by the caller; the adapter never creates it.
 */
export interface BackendStartSessionOptions {
  sessionDir: string;
  port?: number;
  /** Absolute path to the target .pen file — required for `pencil-mcp`. */
  penFilePath?: string;
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

/** Runtime dependencies a backend factory may require. */
export interface GetBackendDeps {
  /** Active tool names from the OMP harness. Used by the pencil-mcp backend. */
  getActiveTools?: () => string[];
}

/**
 * Resolve a backend by id. Local-html has no runtime deps; pencil-mcp needs
 * the harness's active tool list to validate that the Pencil MCP server is
 * connected. Additional MCP-based backends (figma, paper) will register
 * through the same factory.
 */
export function getBackend(
  id: UiDesignBackendId,
  deps: GetBackendDeps = {},
): UiDesignBackend {
  if (id === "local-html") {
    return createLocalHtmlBackend();
  }
  if (id === "pencil-mcp") {
    const getActiveTools = deps.getActiveTools;
    if (!getActiveTools) {
      throw new BackendUnavailableError(
        "Backend 'pencil-mcp' requires `getActiveTools` — pass the OMP platform's tool introspection hook.",
      );
    }
    return createPencilMcpBackend({ getActiveTools });
  }
  throw new BackendUnavailableError(
    `Backend '${id}' is not available. Supported: local-html, pencil-mcp.`,
  );
}