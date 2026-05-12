# Architecture

This document contains the canonical layer table used by the harness `layer-context-inject` hook. The hook parses the first Markdown table with `Layer`, `Files`, `Allowed`, and `Forbidden` columns, then injects the matching rule before an agent edits a covered file.

## Layer table

| Layer | Files | Allowed | Forbidden | Description |
|---|---|---|---|---|
| lib | `src/lib/**` | — | — | Independent library code. It must not assume command, platform, or application runtime state. |
| app | `src/app/**` | lib | — | Application-facing code. It may import lib, but should not bypass lib with duplicate helpers. |

## Interpretation rules

- `Files` entries are comma-separated glob patterns; keep backticks around globs for readability.
- `Allowed` and `Forbidden` entries are comma-separated layer names; `—` means an empty list.
- Add a new row before creating a new architectural layer covered by the harness.
- Files not matched by this table remain governed by existing repository conventions and `docs/golden-principles.md`.
