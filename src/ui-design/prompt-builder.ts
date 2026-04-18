import type { ContextScan } from "./types.js";

export interface UiDesignKickoffOptions {
  topic?: string;
  sessionDir: string;
  companionUrl: string;
  contextScanSummary: string;
}

/**
 * Build the kickoff user-message. The system-prompt override carries the full
 * phase contract; the kickoff itself just triggers the first turn and provides
 * the session coordinates.
 */
export function buildUiDesignKickoffPrompt(opts: UiDesignKickoffOptions): string {
  const lines: string[] = [
    "Begin the Design Director workflow for `/supi:ui-design`.",
    "",
    `Session directory: \`${opts.sessionDir}\``,
    `Companion URL: ${opts.companionUrl}`,
    "",
    "## Context Scan",
    "",
    opts.contextScanSummary.trim(),
    "",
  ];

  if (opts.topic) {
    lines.push(`Design target: ${opts.topic}`, "");
    lines.push(
      "Start Phase 1: use `planning_ask` to confirm the scope (page / flow / component) for this target, then update `manifest.json`.",
    );
  } else {
    lines.push(
      "No target provided. Start Phase 1: use `planning_ask` to learn what the user wants to design, then confirm the scope (page / flow / component) before updating `manifest.json`.",
    );
  }

  return lines.join("\n");
}

/**
 * Pre-render a compact markdown summary of the ContextScan for use in the
 * kickoff prompt and the director system-prompt block. Stays under ~500 bytes.
 */
export function renderContextScanSummary(scan: ContextScan): string {
  const framework = scan.packageInfo.status === "ok" ? scan.packageInfo.framework : "missing";
  const tokens = scan.tokens.status === "ok" ? scan.tokens.source : scan.tokens.status;
  const componentCount = scan.components.status === "ok" ? scan.components.items.length : 0;
  const componentsLabel =
    scan.components.status === "ok" ? `${componentCount}` : scan.components.status;
  const designMd =
    scan.designMd.status === "ok" ? scan.designMd.path : `design.md: ${scan.designMd.status}`;
  const uiLibs =
    scan.packageInfo.status === "ok" && scan.packageInfo.uiLibraries.length > 0
      ? scan.packageInfo.uiLibraries.join(", ")
      : "none";

  return [
    `- Framework: ${framework}`,
    `- Tokens: ${tokens}`,
    `- Components: ${componentsLabel}`,
    `- design.md: ${scan.designMd.status === "ok" ? designMd : "missing"}`,
    `- UI libraries: ${uiLibs}`,
  ].join("\n");
}
