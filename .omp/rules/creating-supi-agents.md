---
description: "Interactive guide for creating supipowers review agents and keeping their prompts, tools, and outputs maintainable."
---
# Creating Supi Agents

Use when adding or changing supipowers review agents.

Guidance:
- Define the agent’s narrow review domain, trigger, required evidence, and output schema before writing prompt text.
- Give agents only the tools and context needed for their review surface.
- Keep findings actionable: severity, path, line, evidence, and remediation.
- Avoid duplicate agents with overlapping mandates; route or consolidate instead.
- Add fixtures/tests for happy path, no-finding path, malformed output, and false-positive suppression.
