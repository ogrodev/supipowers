/**
 * Decide which per-layer docs need regeneration, which to skip, and which were
 * hand-edited by the user.
 *
 * Pure function over filesystem reads. Inputs:
 *   - the active layer set
 *   - the cwd hosting `docs/layers/<id>.md`
 *   - the expected source hash per layer
 *
 * Outputs the three buckets the docs stage acts on:
 *   - `regen`: missing doc OR sourceHash mismatch with provenance intact
 *   - `skip`:  doc exists, provenance intact, sourceHash matches expected
 *   - `userEdited`: marker present but body hash mismatch (or marker missing on a file
 *      that exists at the well-known path)
 *
 * The docs stage refuses to overwrite `userEdited` files; it surfaces them as warnings.
 */

import * as fs from "node:fs";

import type { HarnessLayerRule } from "../../types.js";
import { getHarnessRepoDocsLayerPath } from "../project-paths.js";
import type { PlatformPaths } from "../../platform/types.js";
import {
  detectUserEdit,
  parseProvenance,
} from "./provenance.js";

export type RegenAction = "regen" | "skip" | "userEdited";

export interface RegenDecisionEntry {
  layerId: string;
  action: RegenAction;
  /** Reason note; useful for tracing decisions. */
  reason: string;
}

export interface DecideRegenSetInput {
  paths: PlatformPaths;
  cwd: string;
  layers: readonly HarnessLayerRule[];
  /** Map from layer id → expected source hash. Missing entries default to "regen". */
  expectedSourceHashes: ReadonlyMap<string, string>;
}

export interface DecideRegenSetResult {
  /** Convenience: layers that must regen. */
  regen: string[];
  /** Convenience: layers that can skip. */
  skip: string[];
  /** Convenience: layers preserved because the user edited them. */
  userEdited: string[];
  /** Full per-layer decision trace. */
  entries: RegenDecisionEntry[];
}

/**
 * Compute the regen decision for every layer. Reads the repo-local docs/layers/<id>.md
 * if it exists; never writes.
 */
export function decideRegenSet(input: DecideRegenSetInput): DecideRegenSetResult {
  const entries: RegenDecisionEntry[] = [];
  for (const layer of input.layers) {
    const docPath = getHarnessRepoDocsLayerPath(input.paths, input.cwd, layer.layer);
    const expected = input.expectedSourceHashes.get(layer.layer);

    if (!fs.existsSync(docPath)) {
      entries.push({
        layerId: layer.layer,
        action: "regen",
        reason: "doc missing",
      });
      continue;
    }

    let contents: string;
    try {
      contents = fs.readFileSync(docPath, "utf8");
    } catch (error) {
      entries.push({
        layerId: layer.layer,
        action: "regen",
        reason: `unable to read doc: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    const editState = detectUserEdit(contents);
    if (editState === "unmarked") {
      entries.push({
        layerId: layer.layer,
        action: "userEdited",
        reason: "doc has no harness-docs marker; treated as user-authored",
      });
      continue;
    }
    if (editState === "edited") {
      entries.push({
        layerId: layer.layer,
        action: "userEdited",
        reason: "doc body hash differs from marker contentHash; user edits preserved",
      });
      continue;
    }

    // intact → compare frontmatter sourceHash to expected.
    if (!expected) {
      entries.push({
        layerId: layer.layer,
        action: "regen",
        reason: "no expected source hash supplied",
      });
      continue;
    }

    const sourceHash = readFrontmatterSourceHash(contents);
    if (!sourceHash) {
      entries.push({
        layerId: layer.layer,
        action: "regen",
        reason: "doc is intact but frontmatter lacks sourceHash",
      });
      continue;
    }
    if (sourceHash !== expected) {
      entries.push({
        layerId: layer.layer,
        action: "regen",
        reason: "frontmatter sourceHash does not match expected (inputs changed)",
      });
      continue;
    }

    entries.push({
      layerId: layer.layer,
      action: "skip",
      reason: "doc is up-to-date",
    });
  }

  return {
    regen: entries.filter((e) => e.action === "regen").map((e) => e.layerId),
    skip: entries.filter((e) => e.action === "skip").map((e) => e.layerId),
    userEdited: entries.filter((e) => e.action === "userEdited").map((e) => e.layerId),
    entries,
  };
}

/**
 * Extract the `sourceHash:` value from the YAML frontmatter of a docs file. Returns
 * null when the doc lacks well-formed frontmatter.
 */
function readFrontmatterSourceHash(markdown: string): string | null {
  const parsed = parseProvenance(markdown);
  const body = parsed ? parsed.body : markdown;
  if (!body.startsWith("---")) return null;
  const firstNewline = body.indexOf("\n");
  if (firstNewline < 0) return null;
  const closeIdx = body.indexOf("\n---", firstNewline);
  if (closeIdx < 0) return null;
  const inner = body.slice(firstNewline + 1, closeIdx);
  for (const line of inner.split("\n")) {
    const match = line.match(/^sourceHash\s*:\s*(.+)\s*$/);
    if (match) return match[1].trim();
  }
  return null;
}
