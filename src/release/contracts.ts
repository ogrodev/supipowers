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

import { Type, type Static } from "@sinclair/typebox";

// ── Release-note polish ───────────────────────────────────────

export const RELEASE_NOTE_STATUSES = ["ok", "empty"] as const;
export type ReleaseNoteStatus = (typeof RELEASE_NOTE_STATUSES)[number];

export const ReleaseNotePolishOutputSchema = Type.Object(
  {
    title: Type.String({ minLength: 1 }),
    body: Type.String(),
    highlights: Type.Array(Type.String({ minLength: 1 })),
    status: Type.Union(RELEASE_NOTE_STATUSES.map((value) => Type.Literal(value))),
  },
  { additionalProperties: false },
);

export type ReleaseNotePolishOutput = Static<typeof ReleaseNotePolishOutputSchema>;

// ── Release doc-fix ───────────────────────────────────────────

export const RELEASE_DOC_FIX_STATUSES = ["ok", "blocked"] as const;
export type ReleaseDocFixStatus = (typeof RELEASE_DOC_FIX_STATUSES)[number];

export const ReleaseDocFixEditSchema = Type.Object(
  {
    file: Type.String({ minLength: 1 }),
    instructions: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const ReleaseDocFixOutputSchema = Type.Object(
  {
    edits: Type.Array(ReleaseDocFixEditSchema),
    summary: Type.String({ minLength: 1 }),
    status: Type.Union(RELEASE_DOC_FIX_STATUSES.map((value) => Type.Literal(value))),
  },
  { additionalProperties: false },
);

export type ReleaseDocFixEdit = Static<typeof ReleaseDocFixEditSchema>;
export type ReleaseDocFixOutput = Static<typeof ReleaseDocFixOutputSchema>;

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
