---
condition:
  - '\b([pP][lL][aA][cC][eE][hH][oO][lL][dD][eE][rR]|[oO][mM][iI][tT][tT][eE][dD]|[tT][rR][uU][nN][cC][aA][tT][eE][dD]|[rR][eE][sS][tT] [oO][fF]|TODO: implement|[sS][tT][uU][bB])\b'
triggers:
  - language indicating elided or scaffold-only output
scope:
  - text
---
# Full Output Enforcement

When producing deliverables:
- Do not ship stubs, placeholders, elided code, or TODO implementations.
- If output must be split, stop at a valid boundary and continue with the next complete chunk.
- Keep code copy-pasteable and syntactically complete.
- Never claim a feature is done when part of it is only scaffolded.
