import type { ResolvedModel } from "../types.js";

/**
 * Shared types for `/supi:ui-design`.
 *
 * Canonical definitions for the Design Director pipeline. Every runtime module,
 * test, and the director prompt MUST reference these types — no shadow definitions.
 * See `.omp/supipowers/specs/2026-04-18-ui-design-design.md` for the contract.
 */

export type UiDesignScope = "page" | "flow" | "component";

export type UiDesignBackendId = "local-html";

export type ScanFieldStatus = "ok" | "missing" | "error";

export type ManifestStatus =
  | "in-progress"
  | "critiquing"
  | "awaiting-review"
  | "complete"
  | "discarded";

/** Output of the deterministic design-token scanner. */
export type DesignTokens =
  | { status: "missing" }
  | { status: "error"; reason: string }
  | {
      status: "ok";
      source: "tailwind" | "css-vars";
      colors: Record<string, string>;
      fonts: Record<string, string[]>;
      raw: string;
    };

/** One discovered component in the user's codebase. */
export interface ExistingComponent {
  name: string;
  /** Path relative to repo root. */
  path: string;
  framework: "react" | "vue" | "svelte" | "unknown";
  exports: string[];
}

/** Full output of `scanDesignContext`. Never throws; fields degrade independently. */
export interface ContextScan {
  scannedAt: string;
  tokens: DesignTokens;
  components:
    | { status: "missing"; items: [] }
    | { status: "error"; items: []; reason: string }
    | { status: "ok"; items: ExistingComponent[] };
  designMd:
    | { status: "missing" }
    | { status: "error"; reason: string }
    | { status: "ok"; path: string; bytes: number };
  packageInfo:
    | { status: "missing" }
    | { status: "error"; reason: string }
    | {
        status: "ok";
        framework: "react" | "vue" | "svelte" | "next" | "nuxt" | "unknown";
        uiLibraries: string[];
      };
}

/** Minimal handle passed between modules describing a ui-design session. */
export interface UiDesignSession {
  id: string;
  dir: string;
  scope?: UiDesignScope;
  topic?: string;
  backend: UiDesignBackendId;
  companionUrl: string;
  resolvedModel?: ResolvedModel;
}

/** Canonical manifest written by the director at every phase transition. */
export interface Manifest {
  id: string;
  scope?: UiDesignScope;
  topic?: string;
  backend: UiDesignBackendId;
  status: ManifestStatus;
  acknowledged: boolean;
  createdAt: string;
  approvedAt?: string;
  components: string[];
  sections: string[];
  page: string;
  critique?: { fixableCount: number; advisoryCount: number; fixIterations: number };
}
