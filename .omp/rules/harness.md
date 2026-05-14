---
description: "Supipowers harness reference for architecture docs, anti-slop guardrails, queues, pipeline stages, and marker-gated hooks."
---
# Harness

Use when modifying `src/harness/**`, harness commands, hooks, docs, or queue artifacts.

Project contract:
- The harness is active only when `.omp/supipowers/harness/marker.json` exists.
- Layer-context injection reads the first table in `docs/architecture.md`; keep the table parseable.
- Golden principles in `docs/golden-principles.md` are review blockers unless the design spec changes.
- Duplicate/dead-code/architecture findings must not be suppressed; fix causes or record visible queue entries.
- Harness storage, path, and subprocess behavior must be cross-platform.
- Verify with targeted harness tests, then `bun ci` when behavior crosses subsystems.
