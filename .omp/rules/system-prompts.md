---
description: "System prompt and agent instruction authoring patterns for reliable, maintainable AI behavior."
---
# System Prompts

Use when writing system prompts, agent definitions, tool docs, or model-facing policies.

Guidance:
- Put hierarchy and authority boundaries first; state what overrides what.
- Prefer MUST/NEVER constraints for safety-critical behavior, SHOULD for taste.
- Use structural tags consistently and define their meaning once.
- Separate role, workflow, tool-use rules, output contract, and verification rules.
- Remove duplicate instructions; repeated constraints should live in one canonical section.
- Keep examples short and failure-focused.
