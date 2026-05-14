---
condition:
  - '\b([wW][rR][iI][tT][eE]|[aA][dD][dD]|[iI][mM][pP][lL][eE][mM][eE][nN][tT]|[cC][hH][aA][nN][gG][eE]|[fF][iI][xX]|[rR][eE][fF][aA][cC][tT][oO][rR])\b.*\b([tT][eE][sS][tT]|[tT][eE][sS][tT][sS]|[sS][pP][eE][cC]|[cC][oO][vV][eE][rR][aA][gG][eE])\b'
triggers:
  - write/add/implement/change/fix/refactor + test/tests/spec/coverage
scope:
  - text
---
# TDD

When the task involves behavior with observable inputs and outputs:
- Add or update the failing test first.
- Keep the test focused on behavior/invariants, not current strings or implementation plumbing.
- Cover edge values, error paths, and cross-field invariants.
- Implement the smallest production change that passes.
- Refactor only after the test proves the behavior.
