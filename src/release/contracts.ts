// src/release/contracts.ts
//
// Schema-backed contracts for AI-assisted release subflows. The release
// command has two AI sessions that must not degrade into free-form text:
//
//   1. Release-note polish — the model rewrites the raw changelog into
//      user-facing release notes. Returns a structured artifact rather
//      than arbitrary markdown so the caller can reason about title,
//      body, and highlights independently.
//   2. Release doc-fix — when doc-drift is detected before a release,
//      the fixer agent applies documentation edits and reports back a
//      structured summary of what it changed (or declares `blocked`).
//
// Both schemas flow through runWithOutputValidation so the retry loop
// hands validation errors back to the model rather than letting the
// release command publish on malformed output.

import { z } from "zod/v4";

// ── Release-note polish ───────────────────────────────────────

export const RELEASE_NOTE_STATUSES = ["ok", "empty"] as const;
export type ReleaseNoteStatus = (typeof RELEASE_NOTE_STATUSES)[number];

export const ReleaseNotePolishOutputSchema = z.object({
  title: z.string().min(1),
  body: z.string(),
  highlights: z.array(z.string().min(1)),
  status: z.enum(RELEASE_NOTE_STATUSES),
}).strict();

export type ReleaseNotePolishOutput = z.infer<typeof ReleaseNotePolishOutputSchema>;

// ── Release doc-fix ───────────────────────────────────────────

export const RELEASE_DOC_FIX_STATUSES = ["ok", "blocked"] as const;
export type ReleaseDocFixStatus = (typeof RELEASE_DOC_FIX_STATUSES)[number];

export const ReleaseDocFixEditSchema = z.object({
  file: z.string().min(1),
  instructions: z.string().min(1),
}).strict();

export const ReleaseDocFixOutputSchema = z.object({
  edits: z.array(ReleaseDocFixEditSchema),
  summary: z.string().min(1),
  status: z.enum(RELEASE_DOC_FIX_STATUSES),
}).strict();

export type ReleaseDocFixEdit = z.infer<typeof ReleaseDocFixEditSchema>;
export type ReleaseDocFixOutput = z.infer<typeof ReleaseDocFixOutputSchema>;

/**
 * Render a polished release-note artifact as markdown suitable for
 * surface to the user and execution by the release pipeline. Produces a
 * level-2 title, optional highlight bullets, and the grouped body.
 */
export function renderPolishedChangelog(output: ReleaseNotePolishOutput): string {
  if (output.status === "empty") {
    return output.body.trim().length > 0
      ? output.body.trim()
      : "_No notable changes in this release._";
  }

  const parts: string[] = [];
  parts.push(`## ${output.title}`);
  if (output.highlights.length > 0) {
    parts.push("");
    parts.push("### Highlights");
    parts.push("");
    for (const h of output.highlights) {
      parts.push(`- ${h}`);
    }
  }
  const body = output.body.trim();
  if (body.length > 0) {
    parts.push("");
    parts.push(body);
  }
  return parts.join("\n");
}
