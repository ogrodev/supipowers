---
description: "Stress-test plans against repository terminology, architecture docs, and recorded decisions before implementation."
---
# Grill With Docs

Use when a plan needs pressure-testing against project language and existing decisions.

Process:
- Read `AGENTS.md`, `docs/architecture.md`, `docs/golden-principles.md`, and the closest domain docs/specs.
- Challenge renamed concepts, duplicated abstractions, and assumptions that conflict with documented layers.
- Prefer updating the source document when a decision changes; do not let implementation drift silently.
- Distinguish locked decisions from open questions.
- Convert vague terms into project-native names before code is written.
