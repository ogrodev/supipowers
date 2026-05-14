---
description: "Reference for creating, editing, and optimizing OMP/agent skills with clear triggers and lean content."
---
# Skill Creator

Use when creating or modifying skills.

Guidance:
- A skill is on-demand knowledge or procedure; it should not carry project-wide behavior unless always needed.
- Front-load the description with exact trigger phrases and exclusions.
- Keep `SKILL.md` short; move long references, templates, and examples into supporting files.
- Use `disable-model-invocation: true` for workflows that should be explicitly slash-invoked.
- Avoid overlapping triggers across skills; merge or route duplicates.
- Validate activation with realistic user prompts and non-trigger prompts.
