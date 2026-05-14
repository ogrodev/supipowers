---
condition:
  - '\b(PR|pr|[pP][uU][lL][lL] [rR][eE][qQ][uU][eE][sS][tT])\b.*\b([rR][eE][vV][iI][eE][wW]|[cC][oO][mM][mM][eE][nN][tT]|[fF][eE][eE][dD][bB][aA][cC][kK]|[rR][eE][qQ][uU][eE][sS][tT][eE][dD] [cC][hH][aA][nN][gG][eE][sS])\b'
triggers:
  - pull-request wording plus reviewer-comment wording
scope:
  - text
---
# Fix PR

When fixing PR feedback:
- Read the PR/comment context and the affected code before editing.
- Decide whether each comment is valid; reject invalid comments with evidence.
- For valid comments, trace ripple effects across callsites and tests.
- Preserve branch/user changes; do not reset, stash, or delete unrelated work.
- Push only after local verification covers the fix.
