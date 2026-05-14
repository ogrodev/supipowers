---
description: "Guidance for compressing prompts, memory, and documentation while preserving technical meaning and identifiers."
---
# Semantic Compression

Use when reducing context size for prompts, docs, rules, or memory.

Preserve:
- Code, commands, file paths, URLs, identifiers, exact constraints, API names, numbers, and decisions.
- Causal relationships and exception cases.

Remove or compress:
- Predictable grammar, motivational phrasing, duplicated examples, ceremony, and redundant headings.

Rules:
- Do not alter semantics to make text shorter.
- Prefer dense fragments over polished prose when the consumer is another model.
- Keep enough structure for retrieval: short headings, bullets, and stable names.
