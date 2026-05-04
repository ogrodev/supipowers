/**
 * Bare-entry detection + harden/rebuild/cancel routing.
 *
 * Called by `/supi:harness` (no subcommand). Detects whether a marker file already
 * exists at `<repo>/.omp/supipowers/harness/marker.json`. If yes, prompt the user to
 * choose between:
 *  - **harden**: gap-fill mode. Run the pipeline; preserve every hand-tuned config.
 *  - **rebuild**: regenerate everything. Each overwrite requires explicit confirmation.
 *  - **cancel**: abort.
 *
 * If no marker, kick off a fresh install.
 *
 * The function returns a structured `BareEntryDecision` so the command handler routes
 * accordingly without baking the UI into the stage code.
 */

import * as fs from "node:fs";

import type { Platform, PlatformPaths } from "../platform/types.js";
import type { HarnessReRunMode } from "../types.js";
import { getHarnessMarkerPath } from "./project-paths.js";

export type BareEntryDecision =
  | { kind: "fresh-install" }
  | { kind: "rerun"; mode: HarnessReRunMode };

export interface MarkerData {
  installedAt: string;
  backend: string;
  /** Free-form notes about the install, e.g. selected hook toggles. */
  notes?: string[];
}

/** Read the marker. Returns null when missing or unreadable. */
export function loadMarker(paths: PlatformPaths, cwd: string): MarkerData | null {
  const markerPath = getHarnessMarkerPath(paths, cwd);
  if (!fs.existsSync(markerPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(markerPath, "utf8")) as MarkerData;
  } catch {
    return null;
  }
}

/** Detect harness presence. */
export function isHarnessInstalled(paths: PlatformPaths, cwd: string): boolean {
  return loadMarker(paths, cwd) !== null;
}

/**
 * Resolve the bare-entry decision. The UI prompt is delegated to a `prompt` callback so
 * the command handler can swap in a mock during tests.
 */
export async function resolveBareEntry(input: {
  paths: PlatformPaths;
  cwd: string;
  prompt: (options: { title: string; choices: { label: string; value: HarnessReRunMode }[] }) => Promise<HarnessReRunMode | null>;
}): Promise<BareEntryDecision> {
  const marker = loadMarker(input.paths, input.cwd);
  if (!marker) return { kind: "fresh-install" };
  const choice = await input.prompt({
    title: `Harness already installed (backend: ${marker.backend}). What now?`,
    choices: [
      { label: "Harden — gap-fill, preserve hand-tuned configs", value: "harden" },
      { label: "Rebuild — regenerate everything (with per-file confirm)", value: "rebuild" },
      { label: "Cancel", value: "cancel" },
    ],
  });
  return { kind: "rerun", mode: choice ?? "cancel" };
}

/**
 * Write the marker after a successful install. The marker is committable subset; commit
 * it to share the harness presence with the team.
 */
export function writeMarker(
  paths: PlatformPaths,
  cwd: string,
  data: MarkerData,
): { ok: true; path: string } | { ok: false; message: string } {
  const markerPath = getHarnessMarkerPath(paths, cwd);
  try {
    const dir = markerPath.substring(0, markerPath.lastIndexOf("/"));
    if (dir) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(markerPath, JSON.stringify(data, null, 2) + "\n");
    return { ok: true, path: markerPath };
  } catch (error) {
    return {
      ok: false,
      message: `unable to write marker: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Helper for the command handler: build a UI-friendly description of the marker so the
 * status bar can render it.
 */
export function describeMarker(marker: MarkerData | null): string {
  if (!marker) return "harness: not installed";
  return `harness: installed (backend ${marker.backend}, ${new Date(marker.installedAt).toLocaleDateString()})`;
}

// Suppress static-analysis "imported but unused" — `Platform` is reserved for future
// integrations that surface marker info via the platform UI.
type _PlatformUsage = Platform;
void (0 as unknown as _PlatformUsage);
