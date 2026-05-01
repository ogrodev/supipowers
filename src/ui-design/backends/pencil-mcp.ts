import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  BackendUnavailableError,
  type BackendFinalizeReason,
  type BackendStartResult,
  type BackendStartSessionOptions,
  type UiDesignBackend,
} from "../backend-adapter.js";

/**
 * Minimal set of `mcp__pencil_*` tools the Director and its mandatory
 * pencil sub-agents must be able to call for a pencil-mcp session to have a
 * chance of succeeding. Availability is detected by checking the harness's
 * active tools list for these exact names.
 */
export const REQUIRED_PENCIL_TOOLS = [
  "mcp__pencil_open_document",
  "mcp__pencil_get_editor_state",
  "mcp__pencil_batch_get",
  "mcp__pencil_batch_design",
  "mcp__pencil_get_screenshot",
  "mcp__pencil_snapshot_layout",
  "mcp__pencil_search_all_unique_properties",
  "mcp__pencil_export_nodes",
];

/**
 * Check whether the Pencil MCP server is currently connected by inspecting
 * the harness's active tools list. OMP exposes MCP tools as
 * `mcp__<server>_<tool>` — we require every non-optional tool named by the
 * Director workflow or its pencil sub-agent templates.
 */
export function detectPencilMcp(activeTools: string[]): boolean {
  if (!Array.isArray(activeTools) || activeTools.length === 0) return false;
  const set = new Set(activeTools);
  return REQUIRED_PENCIL_TOOLS.every((name) => set.has(name));
}

export interface PencilMcpBackendDeps {
  getActiveTools: () => string[];
}

export interface PencilMcpStartOptions extends BackendStartSessionOptions {
  /** Absolute path to the target .pen file, chosen by the caller. */
  penFilePath?: string;
}

/**
 * Pencil-MCP backend. Owns no long-running process — edits happen through
 * `mcp__pencil_*` tool calls driven by the Design Director. `startSession`
 * validates that the server is still connected and pins the chosen `.pen`
 * path for later `artifactUrl` lookups.
 */
export function createPencilMcpBackend(
  deps: PencilMcpBackendDeps,
): UiDesignBackend {
  let currentSessionDir: string | null = null;

  return {
    id: "pencil-mcp",

    async startSession(opts: PencilMcpStartOptions): Promise<BackendStartResult> {
      if (!detectPencilMcp(deps.getActiveTools())) {
        throw new BackendUnavailableError(
          "Pencil MCP server is not connected. Start the `pencil` MCP server (exposes `mcp__pencil_batch_design` + `mcp__pencil_batch_get`) and retry.",
        );
      }

      if (!opts.penFilePath || !path.isAbsolute(opts.penFilePath)) {
        throw new BackendUnavailableError(
          "pencil-mcp backend requires an absolute `penFilePath`.",
        );
      }

      currentSessionDir = opts.sessionDir;

      // No companion server to tear down — cleanup is an idempotent no-op so
      // the command layer can call it freely on startup-failure paths.
      let cleaned = false;
      const cleanup = async (): Promise<void> => {
        if (cleaned) return;
        cleaned = true;
      };

      return {
        url: pathToFileURL(opts.penFilePath).toString(),
        cleanup,
      };
    },

    artifactUrl(sessionDir: string, artifactPath: string): string | null {
      if (currentSessionDir !== sessionDir) return null;
      if (!artifactPath) return null;
      const absolute = path.isAbsolute(artifactPath)
        ? artifactPath
        : path.join(sessionDir, artifactPath);
      return pathToFileURL(absolute).toString();
    },

    async finalize(sessionDir: string, _reason: BackendFinalizeReason): Promise<void> {
      // Deliberately a no-op: the `.pen` file is user-owned and must survive
      // both `complete` and `discarded` terminal states. The command layer
      // handles session-directory removal on discard; external `.pen` files
      // are never touched here.
      if (currentSessionDir === sessionDir) {
        currentSessionDir = null;
      }
    },
  };
}
