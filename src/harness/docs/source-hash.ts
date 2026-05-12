/**
 * Source-hash composition for the docs stage.
 *
 * The hash is the single trigger that decides whether a per-layer doc needs to be
 * regenerated. It composes every input the subagent sees (layer rule, layer file paths,
 * representative file contents, golden principles, peer layer descriptors, prompt
 * version) into a stable JSON payload, then sha256s the result.
 *
 * Determinism is non-negotiable — any inadvertently mutable input (filesystem order,
 * representative-file ordering, etc.) defeats the cache and forces wasteful re-runs.
 */

import * as crypto from "node:crypto";

import type { HarnessLayerRule } from "../../types.js";

export interface RepresentativeFileFingerprint {
  /** Path relative to the repo root, forward-slashed. */
  path: string;
  /** sha256 of the file contents at hash-compute time. */
  contentHash: string;
}

export interface PeerLayerFingerprint {
  /** Layer id. */
  id: string;
  /** Human-readable description; empty string when the layer rule omits one. */
  description: string;
}

export interface ComputeLayerSourceHashInput {
  /** Layer rule under consideration. Embedded verbatim into the hash payload. */
  layerRule: HarnessLayerRule;
  /** Sorted (lexicographic) list of every file path matching the layer glob. */
  globPaths: readonly string[];
  /** Representative files the subagent reads (top-N by LOC), each with a content hash. */
  representativeFiles: readonly RepresentativeFileFingerprint[];
  /** Repo-wide golden principles, in their original document order. */
  goldenPrinciples: readonly string[];
  /** Peer layer descriptors (id + description). Sorted internally before hashing. */
  peerLayers: readonly PeerLayerFingerprint[];
  /** sha256 of the subagent system prompt at build time. */
  promptVersion: string;
}

/**
 * Compute the deterministic source hash for a single layer doc. Pure function.
 *
 * Sort behavior:
 * - `globPaths` are sorted defensively (lexicographic).
 * - `representativeFiles` are sorted by `path` (lexicographic).
 * - `peerLayers` are sorted by `id` (lexicographic).
 *
 * Determinism contract: any deep-equal set of inputs yields the same hash regardless of
 * caller-provided ordering on the three sorted arrays.
 */
export function computeLayerSourceHash(input: ComputeLayerSourceHashInput): string {
  const sortedGlobPaths = [...input.globPaths].sort((a, b) => a.localeCompare(b));
  const sortedRepFiles = [...input.representativeFiles]
    .map((entry) => ({ path: entry.path, contentHash: entry.contentHash }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const sortedPeerLayers = [...input.peerLayers]
    .map((entry) => ({ id: entry.id, description: entry.description }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const payload = {
    layerRule: serializeLayerRule(input.layerRule),
    globPaths: sortedGlobPaths,
    representativeFiles: sortedRepFiles,
    goldenPrinciples: [...input.goldenPrinciples],
    peerLayers: sortedPeerLayers,
    promptVersion: input.promptVersion,
  };

  return sha256Json(payload);
}

/** Compute sha256 of a UTF-8 string. */
export function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/** Compute sha256 of a JSON-serializable payload. Object key order is preserved verbatim. */
export function sha256Json(payload: unknown): string {
  return sha256(JSON.stringify(payload));
}

/**
 * Reduce a layer rule to a deterministic shape (sorted import lists, normalized description)
 * so two semantically-equal rules produce the same hash regardless of source ordering.
 */
function serializeLayerRule(rule: HarnessLayerRule): {
  layer: string;
  globs: string[];
  allowedImports: string[];
  forbiddenImports: string[];
  description: string;
} {
  return {
    layer: rule.layer,
    globs: [...rule.globs].sort((a, b) => a.localeCompare(b)),
    allowedImports: [...rule.allowedImports].sort((a, b) => a.localeCompare(b)),
    forbiddenImports: [...rule.forbiddenImports].sort((a, b) => a.localeCompare(b)),
    description: rule.description ?? "",
  };
}
