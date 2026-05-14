---
description: "Prompt engineering rules for system prompts, agent instructions, harness prompts, and skill documents."
---
# Prompt Engineering

Use when writing or editing prompts that steer agents.

Guidance:
- Put non-negotiable constraints before workflow tips.
- Use concrete trigger conditions, allowed/forbidden behavior, and verification requirements.
- Prefer explicit output schemas over prose-only format requests.
- Avoid vague adjectives unless paired with measurable behavior.
- Include negative examples only when they prevent common failures.
- Keep reusable reference material out of always-loaded prompts; link it as on-demand rules/docs.
- Test prompts against at least one happy path and one adversarial/edge path.
