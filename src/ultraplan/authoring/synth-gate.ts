/**
 * SYNTHESIZE-stage `$EDITOR` round-trip helper.
 *
 * After the synthesize stage produces `drafts/iteration-N/authored.json`, the user gate
 * lets the user hand-edit a markdown rendering of the draft. The flow:
 *
 *   1. Render the planner's authored.json to authored.md.
 *   2. Open the markdown in `$EDITOR` (blocking) via `openInEditor`.
 *   3. Read the file back, strip any prior parse-error annotations, parse, validate.
 *   4. On clean parse: overlay the patch onto the planner's draft and re-save authored.json.
 *   5. On parse failure: prepend a structured error annotation, re-open. Two consecutive
 *      failures bubble up to a user gate ("keep editing | discard edits | abandon").
 *
 * The helper is a pure orchestrator: it takes a `Platform` for `exec` and otherwise reads
 * and writes through the storage helpers. Tests pass a mock platform whose `exec` fakes the
 * editor by mutating the file in place.
 */

import * as fs from "node:fs";

import type { Platform } from "../../platform/types.js";
import type { PlatformPaths } from "../../platform/types.js";
import type {
  UltraPlanAuthoredArtifact,
} from "../../types.js";
import { openInEditor } from "../../utils/editor.js";
import {
  applyAuthoredPatch,
  annotateParseErrors,
  parseAuthoredFromMarkdown,
  serializeAuthoredToMarkdown,
  stripParseErrorAnnotations,
  type AuthoredMarkdownParseError,
} from "./markdown.js";
import {
  loadDraftAuthoredJson,
  saveDraftAuthoredJson,
  saveDraftAuthoredMarkdown,
  loadDraftAuthoredMarkdown,
} from "./storage.js";
import { validateUltraPlanAuthoredArtifact } from "../contracts.js";

export interface SynthGateInput {
  platform: Platform;
  paths: PlatformPaths;
  cwd: string;
  sessionId: string;
  iteration: number;
  /**
   * Maximum number of editor re-opens after parse errors before yielding control to the
   * caller for a manual recovery decision. Default 2 \u2014 matches the plan's two-strikes rule.
   */
  maxParseRetries?: number;
}

export type SynthGateResult =
  | { status: "saved"; authored: UltraPlanAuthoredArtifact }
  | { status: "parse-failed"; errors: AuthoredMarkdownParseError[] }
  | { status: "no-changes"; authored: UltraPlanAuthoredArtifact }
  | { status: "io-error"; message: string };

/**
 * Run the editor round-trip exactly once: render markdown, open editor, parse on save.
 * Does not loop; the caller decides what to do with parse errors.
 */
export async function runEditorRoundTripOnce(input: SynthGateInput): Promise<SynthGateResult> {
  const { platform, paths, cwd, sessionId, iteration } = input;

  const draftJsonResult = loadDraftAuthoredJson(paths, cwd, sessionId, iteration);
  if (!draftJsonResult.ok) {
    return { status: "io-error", message: `Could not read draft authored.json: ${draftJsonResult.error.message}` };
  }
  const draftValidation = validateUltraPlanAuthoredArtifact(draftJsonResult.value);
  if (!draftValidation.ok) {
    return {
      status: "io-error",
      message: `Draft authored.json failed schema validation before editing: ${draftValidation.errors.join("; ")}`,
    };
  }
  const draft = draftValidation.value;

  // Step 1: render the markdown. If a markdown file already exists for this iteration (e.g.
  // a prior round-trip left annotations), strip them so the user sees a clean file unless we
  // are intentionally re-opening with new errors.
  let markdown = serializeAuthoredToMarkdown(draft);
  const previousMd = loadDraftAuthoredMarkdown(paths, cwd, sessionId, iteration);
  if (previousMd.ok) {
    // Use whatever content the user left in place last time, stripped of annotations.
    markdown = stripParseErrorAnnotations(previousMd.value);
  }

  // Step 2: persist the rendered markdown so the editor opens an existing file.
  const writeResult = saveDraftAuthoredMarkdown(paths, cwd, sessionId, iteration, markdown);
  if (!writeResult.ok) {
    return { status: "io-error", message: `Could not write draft markdown for editor: ${writeResult.error.message}` };
  }

  // Step 3: open in editor. openInEditor awaits the spawned process.
  const filePath = writeResult.value;
  await openInEditor(platform, filePath);

  // Step 4: read the file back. If it didn't change, surface a no-changes result.
  let edited: string;
  try {
    edited = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    return {
      status: "io-error",
      message: `Could not re-read edited markdown: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const cleaned = stripParseErrorAnnotations(edited);
  if (cleaned === markdown) {
    return { status: "no-changes", authored: draft };
  }

  // Step 5: parse + validate.
  const parsed = parseAuthoredFromMarkdown(cleaned);
  if (!parsed.ok) {
    // Re-write with annotation for the next attempt; the caller decides whether to loop.
    const annotated = annotateParseErrors(cleaned, parsed.errors);
    saveDraftAuthoredMarkdown(paths, cwd, sessionId, iteration, annotated);
    return { status: "parse-failed", errors: parsed.errors };
  }

  const applied = applyAuthoredPatch(draft, parsed.patch);
  if (!applied.ok) {
    const errors: AuthoredMarkdownParseError[] = applied.errors.map((message) => ({ line: null, message }));
    const annotated = annotateParseErrors(cleaned, errors);
    saveDraftAuthoredMarkdown(paths, cwd, sessionId, iteration, annotated);
    return { status: "parse-failed", errors };
  }

  // Step 6: persist the merged authored.json. The planner-original snapshot at
  // `authored.planner.json` is preserved (the synth-stage tool wrote it before this gate
  // ran) so we can always compare what shipped vs. what the planner emitted.
  const persisted = saveDraftAuthoredJson(paths, cwd, sessionId, iteration, applied.value);
  if (!persisted.ok) {
    return { status: "io-error", message: `Could not save merged authored.json: ${persisted.error.message}` };
  }

  // Re-write the markdown without annotations so the next opening is clean.
  saveDraftAuthoredMarkdown(paths, cwd, sessionId, iteration, cleaned);

  return { status: "saved", authored: applied.value };
}

/**
 * Run the editor round-trip in a bounded retry loop. After `maxParseRetries` consecutive
 * parse failures, returns the most recent failure for the caller to decide on a manual
 * recovery path.
 */
export async function runSynthGateLoop(input: SynthGateInput): Promise<SynthGateResult> {
  const maxRetries = input.maxParseRetries ?? 2;
  let lastFailure: SynthGateResult | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const result = await runEditorRoundTripOnce(input);
    if (result.status === "saved" || result.status === "no-changes" || result.status === "io-error") {
      return result;
    }
    // parse-failed
    lastFailure = result;
  }
  return lastFailure ?? { status: "io-error", message: "synth gate exhausted retries without producing a result" };
}
