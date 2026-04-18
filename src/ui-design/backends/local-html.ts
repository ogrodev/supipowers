import * as path from "node:path";
import type { VisualServerInfo } from "../../visual/types.js";
import { startVisualServer as realStartVisualServer } from "../../visual/start-server.js";
import { stopVisualServer as realStopVisualServer } from "../../visual/stop-server.js";
import {
  BackendUnavailableError,
  type BackendFinalizeReason,
  type BackendStartResult,
  type BackendStartSessionOptions,
  type UiDesignBackend,
} from "../backend-adapter.js";

export interface LocalHtmlBackendDeps {
  startVisualServer: (opts: { sessionDir: string; port?: number }) => Promise<VisualServerInfo | null>;
  stopVisualServer: (sessionDir: string) => { status: string };
}

const DEFAULT_DEPS: LocalHtmlBackendDeps = {
  startVisualServer: realStartVisualServer,
  stopVisualServer: realStopVisualServer,
};

/**
 * Local HTML companion backend. Wraps `src/visual/` server lifecycle.
 *
 * `sessionDir` is the caller-created directory — we do not manage the manifest
 * file or write design artifacts. The server streams files written to
 * `sessionDir` to a browser companion.
 */
export function createLocalHtmlBackend(
  deps: LocalHtmlBackendDeps = DEFAULT_DEPS,
): UiDesignBackend {
  let currentUrl: string | null = null;
  let currentSessionDir: string | null = null;

  return {
    id: "local-html",

    async startSession(opts: BackendStartSessionOptions): Promise<BackendStartResult> {
      const info = await deps.startVisualServer(
        opts.port !== undefined
          ? { sessionDir: opts.sessionDir, port: opts.port }
          : { sessionDir: opts.sessionDir },
      );

      if (!info) {
        throw new BackendUnavailableError(
          `Failed to start local HTML companion for session ${opts.sessionDir}. Check that the port is free and try again.`,
        );
      }

      currentUrl = info.url;
      currentSessionDir = opts.sessionDir;

      let stopped = false;
      const cleanup = async (): Promise<void> => {
        if (stopped) return;
        stopped = true;
        deps.stopVisualServer(opts.sessionDir);
      };

      return { url: info.url, cleanup };
    },

    artifactUrl(sessionDir: string, artifactPath: string): string | null {
      if (!currentUrl || currentSessionDir !== sessionDir) {
        return null;
      }

      const normalizedPath = artifactPath.split(path.sep).join("/").replace(/^\/?/, "/");
      return new URL(normalizedPath, `${currentUrl}/`).toString();
    },

    async finalize(sessionDir: string, _reason: BackendFinalizeReason): Promise<void> {
      deps.stopVisualServer(sessionDir);
      if (currentSessionDir === sessionDir) {
        currentUrl = null;
        currentSessionDir = null;
      }
    },
  };
}
