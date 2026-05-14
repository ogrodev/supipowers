---
description: "TypeScript code-health analysis for unused files/exports/dependencies, duplication, circular dependencies, and architecture violations."
---
# Fallow

Use for JavaScript/TypeScript code-health work.

Guidance:
- Find unused exports, dead files, duplicate logic, dependency drift, circular imports, and complexity hotspots.
- Confirm static findings against tests, dynamic entry points, package exports, and extension registration before deleting.
- Prefer deleting dead code over adding aliases or suppressions.
- Do not hide unresolved findings; fix the cause or leave a visible queue/review entry.
- For this repo, preserve `src/types.ts` as canonical shared type home and obey `docs/architecture.md` layer rules.
