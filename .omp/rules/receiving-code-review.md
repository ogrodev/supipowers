---
condition:
  - '\b([aA][dD][dD][rR][eE][sS][sS] [rR][eE][vV][iI][eE][wW]|[rR][eE][vV][iI][eE][wW] [fF][eE][eE][dD][bB][aA][cC][kK]|[rR][eE][qQ][uU][eE][sS][tT][eE][dD] [cC][hH][aA][nN][gG][eE][sS]|[cC][oO][mM][mM][eE][nN][tT] [sS][aA][yY][sS])\b'
triggers:
  - address review
  - review feedback
  - requested changes
  - comment says
scope:
  - text
---
# Receiving Code Review

When handling review feedback:
- Verify the reviewer’s claim against code and tests before changing anything.
- If correct, fix the smallest source problem and update affected tests/callsites.
- If incorrect, respond with concrete evidence rather than performative changes.
- Do not introduce aliases, comments, or compatibility shims only to appease a comment.
- Re-run the check that would catch the reviewed issue.
