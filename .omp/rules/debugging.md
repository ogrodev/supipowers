---
condition:
  - '\b([rR][oO][oO][tT] [cC][aA][uU][sS][eE]|[wW][oO][rR][kK][aA][rR][oO][uU][nN][dD]|[cC][aA][nN][nN][oO][tT] [rR][eE][pP][rR][oO][dD][uU][cC][eE]|[fF][iI][xX][eE][dD] [bB][yY]|[iI][sS][sS][uU][eE] [wW][aA][sS])\b'
triggers:
  - root cause
  - workaround
  - cannot reproduce
  - fixed by
  - issue was
scope:
  - text
---
# Debugging

Before claiming root cause or applying a fix:
- Reproduce or identify the failing path from code/tests/logs.
- Form one hypothesis at a time and falsify it with a targeted observation.
- Fix the source, not the symptom; avoid suppressing warnings/errors as a fix.
- Add a regression test for the confirmed failure mode when feasible.
- Report evidence and remaining uncertainty separately.
