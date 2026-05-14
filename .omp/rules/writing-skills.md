---
description: "Guidance for creating, editing, and verifying project skills before deployment."
---
# Writing Skills

Use when authoring OMP/agent skills.

Guidance:
- A skill should solve a recurring task with concrete triggers, not duplicate general system policy.
- Keep the main skill concise: purpose, activation, workflow, pitfalls, verification.
- Move bulky references into separate files and tell the agent exactly when to read them.
- Include exclusions so nearby skills do not overlap.
- Prefer slash commands for explicit interactive workflows.
- Verify by reading the final `SKILL.md`, checking frontmatter, and testing likely trigger/non-trigger prompts.
